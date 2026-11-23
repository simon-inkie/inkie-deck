#!/usr/bin/env bash
# Launch the agent workspace: one tmux window per agent, ready to go.
# Usage: bin/workspace.sh [--windowed] [agent1 agent2 ...]
# No args = all agents. Pass names to launch a subset.
#   bin/workspace.sh inkie basalt                 # tmux windows in current terminal
#   bin/workspace.sh --windowed inkie basalt      # spawn each in its own Windows Terminal
#   bin/workspace.sh                             # everyone, current terminal
#
# Assumes the persona layout from templates/: each agent's home is
# $AGENTS_HOME/<name>/ and holds a SOUL.md. Override AGENTS_HOME if yours
# lives somewhere else.
#
# Each agent runs the runtime named in $AGENTS_HOME/<name>/.runtime (claude,
# codex or agy; claude when absent), or the one given with --runtime. The
# launch commands are the same ones boot-agents.sh sends (runtime-launch.sh),
# so a Codex or Antigravity agent resumes its own workspace's newest session
# here too. Unlike boot-agents.sh this does not verify a Codex resume or wait
# for readiness: you are attached and can see the pane.
#
# WORKSPACE_DRY_RUN=1 prints each agent's launch command instead of starting
# tmux, which is how the tests check runtime selection without a pane. It
# still pins a session id for a new Claude Code agent (the next real launch
# uses it) and still re-syncs an agy agent's GEMINI.md, but it leaves out the
# day-one first message, whose marker would otherwise be used up.

set -euo pipefail

SESSION="agents"
AGENTS_HOME="${AGENTS_HOME:-$HOME/agents}"

# Agent list derived from $AGENTS_HOME/*/ - a dir is an agent iff it holds
# SOUL.md (a runtime-agnostic marker; a bin/ dir has none, dotdirs are
# glob-excluded). Pin a coordinator name first if you have one; the rest in
# glob order. A new agent is auto-included the moment its home + SOUL.md exist.
COORDINATOR="${WORKSPACE_COORDINATOR:-}"
ALL_AGENTS=()
if [[ -n "$COORDINATOR" && -f "$AGENTS_HOME/$COORDINATOR/SOUL.md" ]]; then
  ALL_AGENTS+=("$COORDINATOR")
fi
for _d in "$AGENTS_HOME"/*/; do
  _name="$(basename "$_d")"
  if [[ "$_name" != "$COORDINATOR" && -f "${_d}SOUL.md" ]]; then ALL_AGENTS+=("$_name"); fi
done
WINDOWED=0
RUNTIME_OVERRIDE=""  # set by --runtime flag; empty = use per-agent .runtime file

if [[ "${1:-}" == "--windowed" ]]; then
  WINDOWED=1
  shift
fi

if [[ "${1:-}" == "--runtime" ]]; then
  RUNTIME_OVERRIDE="${2:?--runtime requires a runtime name}"
  shift 2
fi

if [[ $# -gt 0 ]]; then
  AGENTS=("$@")
else
  AGENTS=("${ALL_AGENTS[@]}")
fi

# Pinned claude session ids, shared with boot-agents.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-session.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-binary-check.sh"
# Per-runtime launch constructors, shared with boot-agents.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-launch.sh"

TMUX_AGENTS=()
for agent in "${AGENTS[@]}"; do
  if agent_opts_into_pty "$agent"; then
    echo "workspace: skipping $agent (opted into the PTY runner)" >&2
  else
    TMUX_AGENTS+=("$agent")
  fi
done
[[ ${#TMUX_AGENTS[@]} -gt 0 ]] || exit 0
AGENTS=("${TMUX_AGENTS[@]}")

get_runtime() {
  local agent="$1"
  if [[ -n "$RUNTIME_OVERRIDE" ]]; then
    echo "$RUNTIME_OVERRIDE"
  elif [[ -f "$AGENTS_HOME/$agent/.runtime" ]]; then
    local r; r="$(tr -d '[:space:]' < "$AGENTS_HOME/$agent/.runtime")"
    printf '%s\n' "${r:-claude}"
  else
    echo "claude"
  fi
}

# launch_command <agent> -- print the pane-shell command that starts <agent>.
launch_command() {
  local agent="$1"
  local runtime model_flag=""
  runtime=$(get_runtime "$agent")
  # Per-agent model override (selector): $AGENTS_HOME/<agent>/.model -> --model.
  # Absent = no flag = inherit the global default.
  model_flag="$(agent_model_flag "$AGENTS_HOME/$agent")"
  if [[ "$runtime" == "claude" ]]; then
    # Source the agent's gitignored .env.secrets (if any) before claude, so
    # anything referencing a live secret via ${VAR} resolves in that shell.
    # Secrets should come from a real secret store at boot, never raw in
    # git-tracked config.
    #
    # The session is pinned by id, not resumed by name: `--resume <name>` on a
    # brand new agent opens an interactive picker instead of failing, so a
    # `|| claude` fallback never ran. See claude-session.sh for the pin, the
    # missing-transcript case and the one-off migration of sessions named by
    # hand. If no pin can be written, launch a fresh named session.
    local session_args
    session_args="$(claude_session_args "$agent" "$AGENTS_HOME/$agent")" || {
      echo "workspace: could not pin a session id for $agent; launching an unpinned session" >&2
      session_args="-n $(printf '%q' "$agent")"
    }
    # The dry run leaves the day-one message out: deciding it writes the marker
    # that stops it being sent twice, which would use it up without a launch.
    local first_prompt=""
    [[ "${WORKSPACE_DRY_RUN:-0}" == "1" ]] || first_prompt="$(claude_first_boot_prompt "$session_args" "$AGENTS_HOME/$agent")"
    printf '%s\n' "printf '\\033]0;${agent}\\007'; [ -f $AGENTS_HOME/$agent/.env.secrets ] && . $AGENTS_HOME/$agent/.env.secrets; claude $session_args $model_flag $first_prompt"
  elif [[ "$runtime" == "codex" ]]; then
    # Same envelope as boot-agents.sh (codex_launch_command): identity on the
    # process environment, the provider home it selects, and a resume of this
    # workspace's newest interactive session.
    local role codex_home sid
    role="$(agent_role "$agent")"
    codex_home="$(codex_launch_home_for_agent "$agent")" || {
      echo "workspace: not launching $agent because its Codex provider selection failed" >&2
      return 1
    }
    sid="$(codex_latest_session_for_workspace "$agent" "$codex_home")"
    codex_launch_command "$agent" "$role" "$codex_home" "$sid" "$model_flag"
  elif [[ "$runtime" == "agy" ]]; then
    # Same envelope as boot-agents.sh (agy_launch_command), after the GEMINI.md
    # include sync, resuming this workspace's newest conversation.
    local role cid
    role="$(agent_role "$agent")"
    cid="$(agy_latest_conversation_for_workspace "$agent")"
    agy_sync_includes "$agent"
    agy_launch_command "$agent" "$role" "$cid" "$model_flag"
  else
    # Any other runtime: launch it plainly and let its own config (hooks,
    # AGENT_NAME wiring) do the rest. Add a branch here if a given runtime
    # needs env vars set before the process starts rather than after -- some
    # runtimes only apply hook-declared env to their own shell tool calls, not
    # to the process itself, so a hook-only approach can silently under-scope.
    printf '%s\n' "printf '\\033]0;${agent}\\007'; AGENT_NAME=$agent $runtime $model_flag"
  fi
}

start_agent() {
  local agent="$1" command wrapped
  command="$(launch_command "$agent")" || return 0
  wrapped="$(base_runner_wrap_launch_cmd "$agent" "$command")"
  tmux_base send-keys -t "$SESSION:$agent" "$wrapped" Enter
}

# Dry run: print what would be sent to each agent's pane, start nothing.
if [[ "${WORKSPACE_DRY_RUN:-0}" == "1" ]]; then
  for agent in "${AGENTS[@]}"; do
    if command="$(launch_command "$agent")"; then
      printf '%s\t%s\n' "$agent" "$command"
    fi
  done
  exit 0
fi

# Optional rate-limit / crash auto-recovery companion script, if you have one.
# Set WATCHER_ENABLED=0 to disable. Default: enabled if the script exists.
WATCHER_SCRIPT="${WORKSPACE_WATCHER_SCRIPT:-$AGENTS_HOME/claude-watch.sh}"
WATCHER_ENABLED="${WATCHER_ENABLED:-1}"

start_watcher() {
  local agent="$1"
  [[ "$WATCHER_ENABLED" != "1" ]] && return
  [[ ! -x "$WATCHER_SCRIPT" ]] && return
  local target="$SESSION:$agent"
  # Slim side pane (15%) for the watcher; -d keeps focus on the agent pane.
  tmux_base split-window -d -t "$target" -h -p 15 "exec $WATCHER_SCRIPT $target" 2>/dev/null || true
}

# Once for the whole workspace, not per agent. Best-effort: see claude-binary-check.sh.
warn_if_foreign_claude

# Create the base session if it doesn't exist
# Before any pane starts, so Claude Code shows no "focus-events off" hint.
tmux_base start-server 2>/dev/null || true
tmux_base set -g focus-events on 2>/dev/null || true
if ! tmux_base has-session -t "$SESSION" 2>/dev/null; then
  session_created=0
  for agent in "${AGENTS[@]}"; do
    if agent_opts_into_pty "$agent"; then
      continue
    fi
    if [[ $session_created -eq 0 ]]; then
      tmux_base new-session -d -s "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
      session_created=1
    else
      tmux_base new-window -t "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
    fi
    # Re-check after window creation: if ACP/PTY claimed the lock mid-cutover, tear down the empty window and skip launch.
    if agent_opts_into_pty "$agent"; then
      tmux_base kill-window -t "$SESSION:$agent" 2>/dev/null || true
      # If killing the only window removed the session, reset session_created so subsequent agents can start cleanly.
      if ! tmux_base has-session -t "$SESSION" 2>/dev/null; then
        session_created=0
      fi
      continue
    fi
    start_agent "$agent"
    start_watcher "$agent"
  done
fi

# Enable mouse scroll + click, and terminal title passthrough
# (must be after session exists -- tmux server has to be running)
tmux_base set -g mouse on 2>/dev/null || true
tmux_base set -g set-titles on 2>/dev/null || true
tmux_base set -g set-titles-string "#{window_name}" 2>/dev/null || true
tmux_base set -g allow-passthrough on 2>/dev/null || true

# Add any missing agent windows
for agent in "${AGENTS[@]}"; do
  if agent_opts_into_pty "$agent"; then
    continue
  fi
  if ! tmux_base list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$agent"; then
    if ! tmux_base has-session -t "$SESSION" 2>/dev/null; then
      tmux_base new-session -d -s "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
    else
      tmux_base new-window -t "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
    fi
    if agent_opts_into_pty "$agent"; then
      tmux_base kill-window -t "$SESSION:$agent" 2>/dev/null || true
      continue
    fi
    start_agent "$agent"
    start_watcher "$agent"
  fi
done

if ! tmux_base has-session -t "$SESSION" 2>/dev/null; then
  exit 0
fi

LIVE_WINDOWS="$(tmux_base list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null || true)"
[[ -n "$LIVE_WINDOWS" ]] || exit 0

if [[ $WINDOWED -eq 1 ]]; then
  # Spawn each agent in its own Windows Terminal window via wt.exe (WSL only).
  # Each window attaches to the shared tmux session and selects its agent.
  # Use bash -c so the tmux command separator (\;) survives the
  # wt.exe -> wsl.exe -> bash argument chain intact.
  spawned=0
  for agent in "${AGENTS[@]}"; do
    printf '%s\n' "$LIVE_WINDOWS" | grep -qx "$agent" || continue
    wt.exe -w new --title "$agent" \
      wsl.exe -d Ubuntu --cd "$AGENTS_HOME/$agent" -- \
      bash -c "unset TMUX TMUX_PANE TMUX_TMPDIR; exec tmux new-session -t $SESSION \\; select-window -t $agent" \
      >/dev/null 2>&1 &
    spawned=$((spawned + 1))
    sleep 0.5  # stagger so wt.exe instances don't race each other
  done
  wait  # let backgrounded wt.exe calls settle
  echo "Spawned $spawned windowed agents"
else
  # Attach via a grouped session: shares windows but keeps independent focus
  # per client, so two people (or two terminals) can look at different agents
  # in the same tmux session at once.
  TARGET_AGENT=""
  for agent in "${AGENTS[@]}"; do
    if printf '%s\n' "$LIVE_WINDOWS" | grep -qx "$agent"; then
      TARGET_AGENT="$agent"
    fi
  done
  [[ -n "$TARGET_AGENT" ]] || exit 0
  unset TMUX TMUX_PANE TMUX_TMPDIR
  exec tmux new-session -t "$SESSION" \; set-option @base_workspace 1 \; select-window -t "$TARGET_AGENT"
fi
