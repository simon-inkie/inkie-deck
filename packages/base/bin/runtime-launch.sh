#!/usr/bin/env bash
# runtime-launch.sh - per-runtime launch commands, shared by boot-agents.sh and
# workspace.sh so the two launchers cannot drift apart.
#
# Sourced, never run. Every function here is pure apart from reading files
# under $AGENTS_HOME and the runtimes' own session records, so the test suites
# can source it (through boot-agents.sh with BOOT_AGENTS_LIB_ONLY=1, or
# directly) without a tmux server or a runtime installed.
#
# Three runtimes are supported, chosen per agent by $AGENTS_HOME/<name>/.runtime:
#
#   claude  Claude Code. Launched by the callers themselves, because its session
#           pinning lives in claude-session.sh.
#   codex   Codex CLI. codex_launch_command below; resumes the newest
#           interactive session recorded for the agent's own workspace.
#   agy     Antigravity CLI. agy_launch_command below; resumes the newest
#           conversation recorded for the agent's own workspace.
#
# Requires AGENTS_HOME to be set by the caller.

agent_opts_into_pty() {
  local agent_home="$AGENTS_HOME/$1" runner
  # A marker drains tmux admission; a lock keeps it drained after opt-out.
  [[ -e "$agent_home/.runner.lock" || -L "$agent_home/.runner.lock" ]] && return 0
  [[ -f "$agent_home/.runner" ]] || return 1
  runner="$(< "$agent_home/.runner")" || return 1
  [[ "$runner" =~ ^[[:space:]]*pty[[:space:]]*$ ]]
}

# agent_role <agent> -- the optional one-line role in $AGENTS_HOME/<agent>/.role.
agent_role() {
  local file="$AGENTS_HOME/$1/.role"
  [[ -f "$file" ]] || return 0
  head -n 1 "$file" 2>/dev/null | tr -d '\r'
}

# agent_inbox_root_env <agent> -- print " INBOX_ROOT=<quoted path>" when the
# agent has an .inbox-root marker, else nothing.
#
# Why a marker and not the settings file: a Claude Code agent gets INBOX_ROOT
# from the env block of its .claude/settings.json, which Codex and Antigravity
# never read. create-agent.sh writes the resolved root into .inbox-root for
# those two runtimes, and the launchers put it on the runtime's own process
# environment, which both runtimes pass on to the shell commands the agent runs.
# Only an absolute, single-line path is used; anything else is ignored with a
# warning rather than placed on a command line.
agent_inbox_root_env() {
  local file="$AGENTS_HOME/$1/.inbox-root" root
  [[ -f "$file" ]] || return 0
  root="$(head -n 1 "$file" 2>/dev/null | tr -d '\r')"
  if [[ "$root" != /* ]]; then
    echo "runtime-launch: ignoring $file: '$root' is not an absolute path" >&2
    return 0
  fi
  printf ' INBOX_ROOT=%q' "$root"
}

# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------

# codex_latest_session_for_workspace <agent> -- print the id of the most recent
# Codex session belonging to this agent's own workspace, or nothing if there is
# none. Silent on every failure mode (missing sessions directory, unreadable
# file, malformed first line, no match): a lookup that cannot answer must never
# block a boot.
#
# MECHANISM. Sessions live at
# $CODEX_SESSIONS_DIR/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl, and line 1
# is a single-line `session_meta` record whose payload carries cwd, id,
# session_id, originator and thread_source. Nothing else in the file is needed,
# so only the first line of each candidate is ever read. File mtime tracks live
# session activity, so an mtime-descending scan answers "most recent real
# conversation" directly. Codex also keeps a session index file, but it is not
# reliably maintained and must not be used for this.
#
# THREE FILTERS, ALL LOAD-BEARING:
#   - originator == "codex-tui" excludes non-interactive `codex exec` runs,
#     which land in the same directory and are often the newest file there.
#   - thread_source == "user" excludes subagent threads spawned inside a
#     session, which are not the conversation anyone wants resumed.
#   - cwd == "$AGENTS_HOME/<agent>", matched THROUGH the closing quote, so a
#     shorter agent name can never match a longer one that starts with it
#     (agent "inkie" must not resume a session belonging to "inkie-scratch").
#
# The id comes from the parsed payload, not from string-stripping the filename,
# so a change to Codex's filename format cannot quietly start yielding wrong
# ids. The filename is still load-bearing for the mtime scan itself, so the
# parsed id is cross-checked against the uuid suffix of the file it came from;
# a mismatch is treated as a malformed line and skipped like any other parse
# failure.
#
# The launchers pass the effective home as the second argument. With no home
# argument, CODEX_SESSIONS_DIR lets the tests supply a fixture directory.
codex_latest_session_for_workspace() {
  local a="$1" dir
  if [[ "$#" -gt 1 ]]; then
    dir="$(codex_sessions_dir_for_home "$2")"
  else
    dir="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
  fi
  local want_cwd="\"cwd\":\"$AGENTS_HOME/$a\""
  [[ -d "$dir" ]] || return 0
  local f line sid fname
  while IFS= read -r f; do
    [[ -n "$f" && -r "$f" ]] || continue
    line=$(head -n 1 -- "$f" 2>/dev/null) || continue
    [[ -n "$line" ]] || continue
    printf '%s' "$line" | grep -qF '"originator":"codex-tui"' || continue
    printf '%s' "$line" | grep -qF '"thread_source":"user"' || continue
    printf '%s' "$line" | grep -qF "$want_cwd" || continue
    sid=$(printf '%s' "$line" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/^"id":"//;s/"$//')
    [[ -n "$sid" ]] || continue
    fname="$(basename -- "$f")"
    case "$fname" in
      *"-${sid}.jsonl") ;;   # parsed id agrees with the filename's own uuid
      *) continue ;;         # mismatch: treat as malformed and skip
    esac
    printf '%s\n' "$sid"
    return 0
  done < <(find "$dir" -type f -name 'rollout-*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | cut -d' ' -f2-)
}

# Resolve the sessions directory for a given CODEX_HOME (or default).
# Empty argument = default ~/.codex/sessions.
codex_sessions_dir_for_home() {
  local home="${1:-}"
  if [[ -n "$home" ]]; then
    echo "$home/sessions"
  else
    echo "${HOME}/.codex/sessions"
  fi
}

# Construct the canonical codex launch command for an agent, preserving its
# complete provider envelope across both initial launch and crash-fallback.
# Arguments: agent_name role codex_home [session_id] [model_flag]
codex_launch_command() {
  local a="$1" role="${2:-}" codex_home="${3:-}" sid="${4:-}" model_flag="${5:-}"
  local q_a q_role q_home q_secrets
  q_a=$(printf '%q' "$a")
  q_role=$(printf '%q' "$role")
  q_secrets=$(printf '%q' "$AGENTS_HOME/$a/.env.secrets")
  local command="printf '\\033]0;%s\\007' $q_a; [ -f $q_secrets ] && . $q_secrets; env AGENT_NAME=$q_a AGENT_ROLE=$q_role$(agent_inbox_root_env "$a")"
  if [[ -n "$codex_home" ]]; then
    q_home=$(printf '%q' "$codex_home")
    command="$command CODEX_HOME=$q_home"
  fi
  command="$command codex"
  [[ -n "$model_flag" ]] && command="$command $model_flag"
  if [[ -n "$sid" ]]; then
    local q_sid
    q_sid=$(printf '%q' "$sid")
    command="$command resume $q_sid"
  fi
  printf '%s\n' "$command"
}

# codex_home_for_agent <agent>
# Provider state is written by bin/codex-provider-switch. A committed rollback
# must survive the next boot even though the dormant Azure home remains on disk.
# Backwards compatibility is deliberate: agents without provider state retain
# the pre-switch behaviour where the presence of .codex-home selects it.
codex_home_for_agent() {
  local a="$1" agent_home azure_home provider_file provider=""
  agent_home="$AGENTS_HOME/$a"
  azure_home="$agent_home/.codex-home"
  provider_file="${PROVIDER_SWITCH_STATE_ROOT:-$HOME/.the-vault/agents}/$a/provider-switch/provider.json"
  if [[ -e "$provider_file" ]]; then
    [[ -r "$provider_file" ]] || {
      echo "boot-agents: $a provider state exists but is unreadable" >&2
      return 1
    }
    command -v python3 >/dev/null 2>&1 || {
      echo "boot-agents: python3 is required to read $a provider state" >&2
      return 1
    }
    provider=$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); provider=value.get("provider"); assert provider in ("plus", "azure"); print(provider)' "$provider_file" 2>/dev/null) || {
      echo "boot-agents: $a provider state is malformed; refusing to guess" >&2
      return 1
    }
  fi
  case "$provider" in
    plus) printf '\n'; return 0 ;;
    azure)
      [[ -f "$azure_home/config.toml" ]] || {
        echo "boot-agents: $a provider state says azure but $azure_home/config.toml is missing" >&2
        return 1
      }
      printf '%s\n' "$azure_home"
      return 0
      ;;
    '')
      [[ -f "$azure_home/config.toml" ]] && printf '%s\n' "$azure_home" || printf '\n'
      return 0
      ;;
    *)
      echo "boot-agents: $a has invalid provider state '$provider'; refusing to guess" >&2
      return 1
      ;;
  esac
}

codex_launch_home_for_agent() {
  local agent="$1" home
  home="$(printenv CODEX_HOME)" || home=""
  if [[ -z "$home" ]]; then
    home="$(codex_home_for_agent "$agent")" || return 1
    home="${home:-$HOME/.codex}"
  fi
  [[ "$home" == /* ]] || home="$AGENTS_HOME/$agent/$home"
  printf '%s\n' "$home"
}

# ---------------------------------------------------------------------------
# Antigravity (agy)
# ---------------------------------------------------------------------------

# agy_latest_conversation_for_workspace <agent> -- print the id of the newest
# Antigravity conversation started in this agent's own home, or nothing.
# Silent on every failure mode: a lookup that cannot answer must never block a
# boot, and no answer means a fresh conversation, which is right for a first
# boot.
#
# WHY NOT `agy --continue`. It resumes the most recent conversation GLOBALLY,
# and the CLI's history spans every directory it was ever run in (scratch
# probes, other repositories, other agents). "Most recent" can therefore be
# somebody else's thread. The history file records the workspace of each
# prompt, so the newest entry for THIS workspace is looked up and resumed
# explicitly with --conversation <id>.
#
# The history file is JSON lines, appended in time order. Compare the decoded
# workspace exactly and ignore unfinished or malformed records. The id must
# be a plain token: it lands on a shell command line.
#
# AGY_HISTORY_FILE is the test seam; the default is where the CLI keeps it.
agy_latest_conversation_for_workspace() {
  local a="$1" hist="${AGY_HISTORY_FILE:-$HOME/.gemini/antigravity-cli/history.jsonl}" cid
  [[ -r "$hist" ]] || return 0
  cid=$(python3 - "$hist" "$AGENTS_HOME/$a" 2>/dev/null <<'PY'
import json
import re
import sys

latest = None
with open(sys.argv[1], "rb") as history:
    for line in history:
        if not line.endswith(b"\n"):
            break
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("workspace") != sys.argv[2]:
            continue
        candidate = record.get("conversationId")
        if isinstance(candidate, str) and candidate:
            latest = candidate
if latest is not None and re.fullmatch(r"[A-Za-z0-9._-]+", latest):
    print(latest)
PY
  ) || return 0
  [[ -n "$cid" ]] || return 0
  printf '%s\n' "$cid"
}

# agy_launch_command <agent> <role> [conversation_id] [model_flag] -- print the
# pane-shell command that launches an Antigravity agent, without running it.
#
# AGENT_NAME is set on the process environment because Antigravity reads no
# settings file of ours: an agent without it cannot use the inbox CLI, which
# refuses to guess who it is. The agent's .env.secrets is sourced first, as for
# the other runtimes. The runtime's own permission prompts stay on.
agy_launch_command() {
  local a="$1" role="${2:-}" cid="${3:-}" model_flag="${4:-}"
  local q_a q_role q_secrets command
  q_a=$(printf '%q' "$a")
  q_role=$(printf '%q' "$role")
  q_secrets=$(printf '%q' "$AGENTS_HOME/$a/.env.secrets")
  command="printf '\\033]0;%s\\007' $q_a; [ -f $q_secrets ] && . $q_secrets; env AGENT_NAME=$q_a AGENT_ROLE=$q_role$(agent_inbox_root_env "$a") agy"
  [[ -n "$model_flag" ]] && command="$command $model_flag"
  [[ -n "$cid" ]] && command="$command --conversation $(printf '%q' "$cid")"
  printf '%s\n' "$command"
}

# agy_sync_includes <agent> -- regenerate the inlined sections of the agent's
# GEMINI.md from their sources before a launch.
#
# Antigravity has no @-import, so the persona and any shared files are copied
# into GEMINI.md between generated fences (sync-gemini-includes.sh). Run before
# every launch so an edit to SOUL.md, say, reaches the next session instead of
# drifting. A failed sync is reported and never blocks the launch: the file it
# leaves behind is the previous, complete one.
agy_sync_includes() {
  local a="$1" gemini="$AGENTS_HOME/$1/GEMINI.md" sync
  [[ -f "$gemini" ]] || return 0
  sync="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-gemini-includes.sh"
  if ! bash "$sync" "$gemini" >/dev/null 2>&1; then
    echo "runtime-launch: could not refresh the inlined sections of $gemini; launching with the previous copy" >&2
  fi
  return 0
}
