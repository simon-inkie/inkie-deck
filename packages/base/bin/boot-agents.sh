#!/usr/bin/env bash
# boot-agents.sh - headless agent-session boot.
#
# Resumes every agent in the shared tmux session (no attach), then auto-arms
# each freshly-launched agent's inbox watcher by typing the arm prompt for it
# (agents reliably forget to arm it themselves on a fresh session, if your
# setup has a watcher at all -- see "Auto-arm" below).
#
# Idempotent: an agent already running is left untouched and not re-armed, so
# this is safe to run repeatedly and safe to fire on boot via a systemd --user
# service or equivalent.
#
# RESUME-ON-RELAUNCH. A claude agent resumes the session pinned in
# $AGENTS_HOME/<name>/.session-id, and a first boot pins a new, named one
# (claude_session_args, in claude-session.sh beside this file). A
# codex agent resumes the newest session belonging to its own workspace
# (codex_latest_session_for_workspace, in runtime-launch.sh) with `codex resume <id>`.
# Without that, a codex agent starts genuinely fresh on every relaunch -- a
# crash, a manual restart, or an incidental relaunch as a side effect of some
# other agent's boot -- and silently loses its whole conversation. A genuine
# first boot, where no session exists for the workspace yet, starts fresh on
# every runtime, as it should. An agy (Antigravity) agent resumes the newest
# conversation recorded for its own workspace in the CLI's history file
# (agy_latest_conversation_for_workspace, in runtime-launch.sh beside this
# file) with `agy --conversation <id>`, and its GEMINI.md is re-synced from its
# sources before every launch (agy_sync_includes, same file).
#
# Boot checks that the Codex process came up after a resume attempt, and
# reports failure if the launch cannot be confirmed. The saved session stays
# available for a retry. Starting a new session is a separate operator action.
#
# Boot also dismisses Codex's blocking "update available" dialog on fresh
# starts and resumes. The process can be running while the dialog is open.
#
# Usage:
#   bin/boot-agents.sh                 # resume + arm all agents, stay headless
#   bin/boot-agents.sh --attach        # same, then attach to the session
#   bin/boot-agents.sh inkie basalt     # only the named agents
#
# After a headless run, view the agents with: tmux attach -t agents
#
# Assumes the templates/ persona layout: each agent's home is
# $AGENTS_HOME/<name>/ and holds a SOUL.md. Override AGENTS_HOME if yours
# lives somewhere else.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

SESSION="agents"
AGENTS_HOME="${AGENTS_HOME:-$HOME/agents}"

# Agent list derived from $AGENTS_HOME/*/ - a dir is an agent iff it holds
# SOUL.md (runtime-agnostic marker). Pin a coordinator name first if you have
# one; the rest in glob order. A new agent is auto-included the moment its
# home + SOUL.md exist.
COORDINATOR="${WORKSPACE_COORDINATOR:-}"
ALL_AGENTS=()
if [[ -n "$COORDINATOR" && -f "$AGENTS_HOME/$COORDINATOR/SOUL.md" ]]; then
  ALL_AGENTS+=("$COORDINATOR")
fi
for _d in "$AGENTS_HOME"/*/; do
  _name="$(basename "$_d")"
  if [[ "$_name" != "$COORDINATOR" && -f "${_d}SOUL.md" ]]; then ALL_AGENTS+=("$_name"); fi
done

ATTACH=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --attach)   ATTACH=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ $# -gt 0 ]]; then
  AGENTS=("$@")
else
  # Check the COUNT before expanding. Under `set -u` the expansion of an empty
  # array is itself fatal on bash 3.2 (still the /bin/bash on macOS), so this
  # guard cannot be written as a test on "${ALL_AGENTS[@]}".
  if [[ ${#ALL_AGENTS[@]} -eq 0 ]]; then
    echo "boot-agents.sh: no agents found in $AGENTS_HOME" >&2
    echo >&2
    echo "An agent is a directory holding a SOUL.md file:" >&2
    echo "    $AGENTS_HOME/<name>/SOUL.md" >&2
    echo >&2
    echo "Persona-file templates for a new agent are in packages/base/templates." >&2
    echo "If your agents live somewhere else, point AGENTS_HOME at it:" >&2
    echo "    AGENTS_HOME=/path/to/agents bin/boot-agents.sh" >&2
    exit 1
  fi
  AGENTS=("${ALL_AGENTS[@]}")
fi

# Pinned claude session ids, shared with workspace.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-session.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-binary-check.sh"
# Per-runtime launch constructors and session lookups, shared with workspace.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-launch.sh"

# Per-agent runtime (claude default; override via $AGENTS_HOME/<name>/.runtime,
# which holds claude, codex or agy). Whitespace is trimmed so a hand-written
# file with a trailing newline still selects the right branch.
get_runtime() {
  local a="$1" r=""
  [[ -f "$AGENTS_HOME/$a/.runtime" ]] && r="$(tr -d '[:space:]' < "$AGENTS_HOME/$a/.runtime")"
  printf '%s\n' "${r:-claude}"
}

# ---------------------------------------------------------------------------
# Codex resume-on-relaunch, and the update-dialog dismissal that shares its
# verification window. Everything from here down to the library boundary is
# pure functions, so the test suite can source this file and exercise them
# without a live tmux session or a live codex process.
# ---------------------------------------------------------------------------

codex_pane_current_command() {
  tmux_base list-panes -t "$1" -F '#{pane_current_command}' 2>/dev/null
}

# codex_pane_has_update_dialog <pane_text> -- return 0 iff the pane is CURRENTLY
# showing Codex's own blocking "update available" dialog, which renders roughly
# as:
#
#   Update available! <installed> -> <published>
#
#   Release notes: <url>
#
#   1. Update now (runs a global npm install)
#   2. Skip
#   3. Skip until next version
#
#   Press enter to continue
#
# WHY IT MATTERS. The dialog blocks startup until someone answers it, and a
# headless boot never does. Its foreground process is still a live `node`
# (Codex is a node CLI), so the crash check in
# codex_verify_launch below would read the pane as healthy while
# the agent sits frozen behind a dialog nobody is going to click.
#
# BOTH ANCHORS ARE REQUIRED, and neither is safe alone. "Press enter to
# continue" is generic enough that some future dialog could reuse it, so
# matching it by itself risks treating an unrelated prompt as this one. The
# headline by itself is worse: once the dialog has been answered, Codex prints
# a STATIC, non-blocking reminder banner on every subsequent launch that
# carries the same headline and blocks nothing at all, so a headline-only match
# would fire on a perfectly healthy pane on every boot from then on.
#
# TAIL-ANCHORED (last 20 lines), the same discipline bin/pane-idle applies to
# Codex's approval dialog and for the same reason: a live dialog is always at
# the bottom of the pane because it IS the bottom, whereas transcript text
# further up that happens to quote either anchor -- an agent discussing this
# very dialog, say -- must not read as a dialog being present. The window is
# fixed rather than configurable because there is exactly one caller and no
# reason for it to vary.
#
# THE FOOTER IS CHECKED ON THE LAST NON-BLANK LINE, NOT ANYWHERE IN THE WINDOW
# (the false positive fixed by independent review, 2026-09). A 20-line window is
# not a small place: a resumed session's pane can carry a RECENT exchange that
# quotes or discusses this very dialog only a few lines above a clean, ready
# composer, and both the quote and the composer then sit inside the same window.
# "Both anchors somewhere in the tail" answers "dialog pending" for that pane.
#
# WHY THAT ONE IS WORSE THAN A MISSED DIALOG. The caller,
# codex_dismiss_update_dialog_if_present below, responds to a true return by
# sending the bare keystroke "3" with no Enter. Against a live dialog the digit
# selects and confirms; against an idle pane there is no dialog to swallow it and
# it lands as a stray character typed into the composer text box. It is not
# submitted, so nothing errors and nothing is logged -- it just sits there as
# staged text, and staged text is exactly what bin/inbox-push's composer-clean
# gate refuses to type over. One false positive on one boot therefore takes that
# agent OFF the delivery path indefinitely, and the evidence is a single
# unexplained "3" nobody typed.
#
# A live dialog's footer is the LAST rendered non-blank line, because Codex draws
# the dialog where the composer would be and there is nothing below it; a
# reference to the dialog in transcript text always has SOMETHING under it, if
# only the composer prompt itself. So the footer anchors on position, and that
# alone rejects the whole class.
#
# THE HEADLINE STAYS A LOOSE MATCH WITHIN THE WINDOW, deliberately. It sits
# several lines above the footer in a real render (release-notes URL and three
# menu options in between), so a last-line rule cannot apply to it, and it is not
# the anchor doing the work here -- the footer's position is.
#
# CONTAINMENT ON THAT LINE, not equality with it. What is load-bearing is WHICH
# line carries the footer, not its exact bytes: captures differ in indentation,
# and a future render that boxes the dialog would put border glyphs around the
# same string. Requiring the exact bytes would trade this false positive for a
# false negative -- a real dialog read as absent, the agent left frozen behind
# it -- the moment either changed.
codex_pane_has_update_dialog() {
  local pane="$1" tail_text last_line
  tail_text=$(printf '%s\n' "$pane" | tail -n 20)
  printf '%s\n' "$tail_text" | grep -qF 'Update available!' || return 1
  # Whitespace-only counts as blank: capture-pane -p trims trailing whitespace
  # per line, but a fixture (or a -e capture read through a stripper) need not.
  last_line=$(printf '%s\n' "$tail_text" | grep -v '^[[:space:]]*$' | tail -n 1)
  printf '%s\n' "$last_line" | grep -qF 'Press enter to continue'
}

# codex_dismiss_update_dialog_if_present <target> -- capture the pane and, if
# the update dialog is up, answer it with option 3, "Skip until next version".
# Silent on the no-dialog path: this runs on every codex launch, and the common
# case of nothing being pending must not add noise to the boot log.
#
# WHY OPTION 3, NOT 1 OR 2. Option 1, "Update now", is the default-highlighted
# choice and runs a global `npm install`. An unattended package upgrade, in the
# middle of a boot, on a machine nobody is watching, is not something this
# script should ever trigger. Option 2, "Skip", reads by its own label as a
# one-shot dismissal rather than a persisted decision, so it is presumed to
# re-prompt on the next relaunch, which would be less a fix than a slower spin
# on the same freeze. Option 3 persists, so the dialog stays gone until there
# is genuinely a newer release to decide about.
#
# THE KEYSTROKE IS "3" ALONE, WITH NO TRAILING ENTER. The digit both selects
# and confirms, and the dialog is gone before a second keystroke could land --
# an Enter sent after it would go into the now-ready composer instead and risk
# submitting an empty prompt.
#
# THE RETURN CODE IS AN OBSERVABILITY CONTRACT, not decoration: 0 means a
# dialog was present and the keystroke was sent, 1 means there was nothing to
# do. The caller has to tell those apart, because a startup that was
# interrupted by a dialog needs more verification than one that was not (see
# codex_verify_launch below). Every path returns explicitly rather
# than falling off the end of the function.
codex_dismiss_update_dialog_if_present() {
  local target="$1" pane
  pane="$(tmux_base capture-pane -t "$target" -p 2>/dev/null)"
  codex_pane_has_update_dialog "$pane" || return 1
  echo "boot-agents: codex update-available dialog detected on $target -- selecting 'Skip until next version' (3)" >&2
  tmux_base send-keys -t "$target" "3"
  return 0
}

# After a settle wait, check the pane's current process. send-keys reports
# whether tmux accepted the command. The launcher runs inside the pane, so
# Boot can only confirm it came up by observing the process.
#
# The update dialog can appear before Codex loads the requested session.
# After dismissal, require three consecutive live reads so a transient
# process during session loading does not pass the verification.
codex_verify_launch() {
  local target="$1" a="$2" sid="$3"
  local wait_secs="${CODEX_RESUME_VERIFY_SECS:-5}"
  [[ "$wait_secs" -gt 0 ]] 2>/dev/null && sleep "$wait_secs"

  local dismissed=1
  codex_dismiss_update_dialog_if_present "$target" && dismissed=0
  [[ -n "$sid" ]] || return 0

  local cmd=""
  if [[ "$dismissed" -eq 0 ]]; then
    local interval="${CODEX_RESUME_POLL_INTERVAL_SECS:-1}" max_checks="${CODEX_RESUME_POLL_MAX_CHECKS:-10}"
    local i=0 consecutive=0
    while [[ "$i" -lt "$max_checks" ]]; do
      [[ "$interval" -gt 0 ]] 2>/dev/null && sleep "$interval"
      cmd="$(codex_pane_current_command "$target")" || cmd=""
      if printf '%s\n' "$cmd" | grep -qiE '^(codex|node)$'; then
        consecutive=$((consecutive + 1))
        [[ "$consecutive" -ge 3 ]] && return 0
      elif [[ -n "$cmd" ]]; then
        break
      else
        consecutive=0
      fi
      i=$((i + 1))
    done
  else
    cmd="$(codex_pane_current_command "$target")" || cmd=""
    if printf '%s\n' "$cmd" | grep -qiE '^(codex|node)$'; then
      return 0
    fi
  fi

  echo "boot-agents: $a's Codex Resume $sid could not be confirmed (pane command: ${cmd:-unavailable}); checkpoint preserved" >&2
  return 1
}

# Readiness is positive evidence, not merely a live node process. Never answer
# first-run permission prompts here; unknown screens remain waiting.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pane-idle"
if [[ "${PANE_IDLE_LIB_VERSION:-0}" -lt 3 ]]; then
  echo "boot-agents: pane-idle library version 3 required" >&2
  exit 1
fi

pane_readiness() {
  local target="$1" runtime="$2" pane cmd composer raw line previous="" anchored=0
  pane=$(tmux_base capture-pane -t "$target" -p 2>/dev/null) || { echo "pane unavailable"; return 1; }
  pane=$(printf '%s\n' "$pane" | tail -n 30)
  if pane_has_codex_approval_dialog "$pane"; then echo "approval prompt: answer manually"; return 1; fi
  cmd=$(tmux_base list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null) || { echo "process unavailable"; return 1; }
  case "$cmd" in
    node|claude|codex|"${runtime##*/}") ;;
    *) echo "runtime not running"; return 1 ;;
  esac
  # Claude and Gemini composers have rules. Codex identifies its composer
  # through its banner and prompt glyph. Menu options are not ready evidence.
  case "$runtime" in
    codex) printf '%s\n' "$pane" | grep -qF 'OpenAI Codex' || { echo "unrecognised screen"; return 1; } ;;
    *) printf '%s\n' "$pane" | grep -qF '────────' || { echo "unrecognised screen"; return 1; } ;;
  esac
  if check_idle "$pane"; then echo "runtime busy"; return 1; fi
  composer=$(find_composer_line "$pane")
  [[ -n "$composer" ]] || { echo "composer unavailable"; return 1; }
  if [[ "$runtime" == codex ]]; then
    printf '%s\n' "$composer" | grep -qE '^[[:space:]]*›' || { echo "composer unconfirmed"; return 1; }
  else
    while IFS= read -r line; do
      if [[ "$line" == "$composer" && "$previous" == *────────* ]]; then anchored=1; fi
      previous="$line"
    done <<< "$pane"
    [[ "$anchored" -eq 1 ]] || { echo "composer unconfirmed"; return 1; }
  fi
  if printf '%s\n' "$composer" | sed -E -e 's/^[[:space:]]*(❯|›|>)[[:space:]]*//' -e $'s/\xc2\xa0//g' | grep -q '[^[:space:]]'; then
    raw=$(tmux_base capture-pane -t "$target" -p -e 2>/dev/null) || { echo "composer unconfirmed"; return 1; }
    raw=$(raw_line_for "$raw" "$composer")
    printf '%s' "$raw" | grep -qF "$(printf '\033[2m')" || { echo "composer contains text or menu selection"; return 1; }
  fi
  echo "ready"
  return 0
}

# Match rendered setup dialogs, rather than phrases in conversation output.
manual_prompt_reason() {
  local pane="$1"
  if pane_has_codex_approval_dialog "$pane"; then
    echo "approval prompt: answer manually"
    return 0
  fi
  printf '%s\n' "$pane" | grep -qE '^[[:space:]]*(❯|›)[[:space:]]*[^[:space:]]' || return 1
  if printf '%s\n' "$pane" | grep -qiE '^[[:space:]]*(Do you trust (the files|this folder|this workspace)|Trust (this folder|the files|this workspace))'; then
    echo "folder trust: attach and choose Yes manually if you trust the folder; do not press Enter, No is preselected"
  elif printf '%s\n' "$pane" | grep -qiE '^[[:space:]]*(Resume a conversation|Select a conversation|Resume picker)([[:space:]?:]|$)'; then
    echo "resume picker: choose a conversation manually"
  elif printf '%s\n' "$pane" | grep -qiE '^[[:space:]]*(.[[:space:]]*)?Do you want to use this API key'; then
    echo "API key approval: attach and choose manually whether to use the stored key"
  elif printf '%s\n' "$pane" | grep -qiE '^[[:space:]]*(Try|Use|Enable|Switch to) (the )?full.?screen (renderer|mode)'; then
    echo "fullscreen offer: answer manually"
  else
    return 1
  fi
}

existing_readiness() {
  local pane reason
  pane=$(tmux_base capture-pane -t "$1" -p 2>/dev/null) || { echo "pane unavailable"; return 1; }
  pane=$(printf '%s\n' "$pane" | tail -n 30)
  if reason=$(manual_prompt_reason "$pane"); then echo "$reason"; return 1; fi
  # launch_agent already confirmed a running runtime. Busy output and a banner
  # scrolled out of view are normal for an existing conversation.
  return 0
}

# A first boot is launched with its first message, so a busy composer is the
# expected state, not a fault. Anything else wait_for_readiness reports still is.
first_boot_readiness() {
  local reason
  reason=$(wait_for_readiness "$@") && return 0
  [[ "$reason" == "runtime busy" ]] && return 0
  printf '%s\n' "$reason"
  return 1
}

wait_for_readiness() {
  local target="$1" runtime="$2" reason="unconfirmed" attempt pane prompt
  local budget="${BOOT_READY_SECS:-45}"
  case "$budget" in ''|*[!0-9]*|0) budget=45 ;; esac
  for ((attempt=0; attempt<budget; attempt++)); do
    if reason=$(pane_readiness "$target" "$runtime"); then return 0; fi
    pane=$(tmux_base capture-pane -t "$target" -p 2>/dev/null | tail -n 30)
    if prompt=$(manual_prompt_reason "$pane"); then
      reason="$prompt"
      break
    fi
    case "$reason" in *manually*) break ;; esac
    sleep 1
  done
  printf '%s\n' "$reason"
  return 1
}

# --- library boundary: the test suite sources this file with
# BOOT_AGENTS_LIB_ONLY=1 to reach the functions above without running any of
# the live tmux work below. Nothing past this point executes in that mode.
if [[ "${BOOT_AGENTS_LIB_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

TMUX_AGENTS=()
for agent in "${AGENTS[@]}"; do
  if agent_opts_into_pty "$agent"; then
    echo "boot-agents: skipping $agent (opted into the PTY runner)" >&2
  else
    TMUX_AGENTS+=("$agent")
  fi
done
[[ ${#TMUX_AGENTS[@]} -gt 0 ]] || exit 0
AGENTS=("${TMUX_AGENTS[@]}")

tmux_base start-server 2>/dev/null || true
# Turn on focus-events before any pane starts, so Claude Code does not show its
# "tmux focus-events off" hint. tmux has no per-session form of this option
# (it is a server option), so it applies to the tmux server these scripts use.
tmux_base set -g focus-events on 2>/dev/null || true

# Launch an agent if it is not already running. Echoes "launched" or "skipped".
launch_agent() {
  local a="$1" target="$SESSION:$1" runtime model_flag=""
  # Re-check runner marker/lock right before tmux admission to close the cutover race.
  if agent_opts_into_pty "$a"; then
    echo "skipped"
    return 0
  fi
  local provider_switch_lock
  provider_switch_lock="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/provider-switch-lock"
  if [[ -x "$provider_switch_lock" ]] && "$provider_switch_lock" active "$a"; then
    echo "skipped:provider-switch"; return
  fi
  runtime=$(get_runtime "$a")
  # Per-agent model override (selector): $AGENTS_HOME/<a>/.model -> --model flag.
  # Absent = no flag = inherit the global default. Applies to all runtimes.
  model_flag="$(agent_model_flag "$AGENTS_HOME/$a")"
  local created_window=0
  if ! tmux_base has-session -t "$SESSION" 2>/dev/null; then
    if ! tmux_base new-session -d -s "$SESSION" -n "$a" -c "$AGENTS_HOME/$a" >/dev/null; then
      echo "boot-agents: session creation failed" >&2
      return 1
    fi
    created_window=1
  elif ! tmux_base list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$a"; then
    tmux_base new-window -t "$SESSION" -n "$a" -c "$AGENTS_HOME/$a" >/dev/null || return 1
    created_window=1
  fi
  # Re-check after window creation: if ACP/PTY claimed the lock mid-cutover, remove the fresh window and refuse send-keys.
  if agent_opts_into_pty "$a"; then
    if [[ $created_window -eq 1 ]]; then
      tmux_base kill-window -t "$target" 2>/dev/null || true
    fi
    echo "skipped"
    return 0
  fi
  if tmux_base list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null | grep -qiE '^(claude|codex|node|agy)$'; then
    echo "skipped"; return
  fi
  if [[ "$runtime" == "claude" ]]; then
    # Source the agent's gitignored .env.secrets (if any) in the pane shell
    # before launching claude, so anything referencing a live secret via
    # ${VAR} resolves. Secrets should come from a real secret store at boot,
    # never raw in git-tracked config.
    #
    # The session is pinned by id, not resumed by name: `--resume <name>` on a
    # brand new agent opens an interactive picker instead of failing, so a
    # `|| claude` fallback never ran and the pane sat at the picker. See
    # claude-session.sh for the pin, the missing-transcript case and the
    # one-off migration of sessions named by hand. If no pin can be written,
    # launch a fresh named session rather than nothing.
    local session_args
    session_args="$(claude_session_args "$a" "$AGENTS_HOME/$a")" || {
      echo "boot-agents: could not pin a session id for $a; launching an unpinned session" >&2
      session_args="-n $(printf '%q' "$a")"
    }
    local first_prompt
    first_prompt="$(claude_first_boot_prompt "$session_args" "$AGENTS_HOME/$a")"
    local claude_cmd
    claude_cmd="$(base_runner_wrap_launch_cmd "$a" "printf '\033]0;${a}\007'; [ -f $AGENTS_HOME/$a/.env.secrets ] && . $AGENTS_HOME/$a/.env.secrets; claude $session_args $model_flag $first_prompt")"
    tmux_base send-keys -t "$target" "$claude_cmd" Enter || return 1
    # The first message is already on its way, so the pane may be busy at once.
    [[ -n "$first_prompt" ]] && { echo "launched:first-boot"; return; }
  elif [[ "$runtime" == "codex" ]]; then
    # codex (Codex CLI runtime). AGENT_NAME/AGENT_ROLE must
    # be REAL OS-level env vars set before the codex process starts.
    local role; role="$(agent_role "$a")"
    local codex_home=""
    codex_home="$(codex_launch_home_for_agent "$a")" || {
      echo "boot-agents: refusing to launch $a because provider selection failed" >&2
      echo "skipped:provider-state"
      return
    }
    local sid
    sid="$(codex_latest_session_for_workspace "$a" "$codex_home")"
    local codex_cmd
    codex_cmd="$(base_runner_wrap_launch_cmd "$a" "$(codex_launch_command "$a" "$role" "$codex_home" "$sid" "$model_flag")")"
    tmux_base send-keys -t "$target" "$codex_cmd" Enter || return 1
    codex_verify_launch "$target" "$a" "$sid" || return 1
  elif [[ "$runtime" == "agy" ]]; then
    # agy (Antigravity CLI). AGENT_NAME, AGENT_ROLE and INBOX_ROOT go on the
    # process environment (agy_launch_command, in runtime-launch.sh), because
    # agy reads no settings file of ours. Resume the newest conversation of
    # THIS workspace, never `--continue`, which is global across directories.
    # GEMINI.md is re-synced first: agy has no @-import, so the persona is
    # inlined and would otherwise drift from its sources.
    local role cid agy_cmd
    role="$(agent_role "$a")"
    cid="$(agy_latest_conversation_for_workspace "$a")"
    agy_sync_includes "$a"
    agy_cmd="$(base_runner_wrap_launch_cmd "$a" "$(agy_launch_command "$a" "$role" "$cid" "$model_flag")")"
    tmux_base send-keys -t "$target" "$agy_cmd" Enter || return 1
  else
    # Any other runtime: launch it plainly. If it needs env vars set before
    # the process starts rather than after, set them here explicitly -- some
    # runtimes only apply hook-declared env to their own shell tool calls, not
    # to the process itself, so a hook-only approach can silently under-scope.
    local other_cmd
    other_cmd="$(base_runner_wrap_launch_cmd "$a" "printf '\033]0;${a}\007'; AGENT_NAME=$a $runtime $model_flag")"
    tmux_base send-keys -t "$target" "$other_cmd" Enter || return 1
  fi
  echo "launched"
}

# Stagger launches so per-agent rehydration spikes don't stack. A cold resume
# can transiently spike memory while loading its context; firing many back to
# back can overlap every spike and put real pressure on the box at boot. A gap
# between real launches lets each spike subside before the next one starts.
# Only sleep after an actual launch (skips are free). Override with
# BOOT_STAGGER_SECS=0 for a fast serial boot on a quiet box.
STAGGER_SECS="${BOOT_STAGGER_SECS:-12}"
declare -a FRESH=()
LAUNCHED=0
ALREADY_UP=0
WAITING=0
FAILED=0
ARMED=0
# Of the waiting agents, how many wait at a dialog only a person can answer
# (folder trust, a picker, an approval) and how many are simply not ready (the
# runtime is not running, an unrecognised screen). Callers that treat pending as
# "waiting on you" need the difference.
PROMPT_WAITING=0
OTHER_WAITING=0
# Once for the whole boot, not per agent. Best-effort: see claude-binary-check.sh.
warn_if_foreign_claude
for a in "${AGENTS[@]}"; do
  if outcome=$(launch_agent "$a"); then
    readiness_check=wait_for_readiness
    [[ "$outcome" == skipped ]] && readiness_check=existing_readiness
    [[ "$outcome" == launched:first-boot ]] && readiness_check=first_boot_readiness
    if reason=$("$readiness_check" "$SESSION:$a" "$(get_runtime "$a")"); then
      if [[ "$outcome" == launched* ]]; then
        if [[ "$outcome" == launched:first-boot ]]; then
          # Typing "arm your monitor" into a pane busy with its first turn
          # would queue it behind day-one setup, so leave it to the next boot.
          [[ -f "$AGENTS_HOME/$a/.auto-arm-watcher" ]] && echo "boot-agents: $a monitor not armed on its first boot; after its first turn, exit its runtime and run boot-agents.sh again to arm it" >&2
        else
          FRESH+=("$a")
        fi
        LAUNCHED=$((LAUNCHED + 1))
        echo "boot-agents: $a launched, ready"
        [[ "$STAGGER_SECS" -gt 0 ]] && sleep "$STAGGER_SECS"
      else
        ALREADY_UP=$((ALREADY_UP + 1))
        echo "boot-agents: $a already up, ready"
      fi
    else
      WAITING=$((WAITING + 1))
      case "$reason" in
        *manually*) PROMPT_WAITING=$((PROMPT_WAITING + 1)) ;;
        *) OTHER_WAITING=$((OTHER_WAITING + 1)) ;;
      esac
      echo "boot-agents: $a waiting: $reason" >&2
    fi
  else
    FAILED=$((FAILED + 1))
    echo "boot-agents: $a launch failed or verification unconfirmed" >&2
  fi
done

# Auto-arm is opt-in per agent, not a hardcoded list: an agent that wants its
# inbox watcher armed automatically on boot creates an empty marker file at
# $AGENTS_HOME/<name>/.auto-arm-watcher. Most agents don't need this; a live
# push/watcher is only worth the noise for a surface that genuinely needs
# sub-turn delivery (a monitored external inbox, say), everyone else relies on
# checking their inbox at the start of a turn.
should_auto_arm() {
  local a="$1"
  [[ -f "$AGENTS_HOME/$a/.auto-arm-watcher" ]]
}

# Only ready, freshly launched, opted-in agents receive monitor instructions.
for a in "${FRESH[@]}"; do
  if ! should_auto_arm "$a"; then
    echo "boot-agents: $a monitor not requested"
    continue
  fi
  target="$SESSION:$a"
  confirmed=0; monitor_reason=""
  monitor_pattern='^[^[:alnum:]]*(Monitor\(|Monitor started([[:space:]]|$))'
  baseline=$(tmux_base capture-pane -t "$target" -p -S -2000 2>/dev/null | grep -ciE "$monitor_pattern")
  # Send once: repeated prompts can create duplicate watchers. Poll only.
  if ! monitor_reason=$(wait_for_readiness "$target" "$(get_runtime "$a")"); then
    echo "boot-agents: $a monitor waiting: $monitor_reason" >&2
  elif tmux_base send-keys -t "$target" "arm your monitor" && sleep 0.7 && tmux_base send-keys -t "$target" Enter; then
    for poll in 1 2 3 4; do
      sleep 8
      observed=$(tmux_base capture-pane -t "$target" -p -S -2000 2>/dev/null | grep -ciE "$monitor_pattern")
      if [[ "$observed" -gt "$baseline" ]]; then
        confirmed=1
        break
      fi
    done
  fi
  if [[ "$confirmed" -eq 1 ]]; then
    ARMED=$((ARMED + 1))
    echo "boot-agents: $a monitor armed (pane confirmation)"
  else
    WAITING=$((WAITING + 1))
    case "$monitor_reason" in
      *manually*) PROMPT_WAITING=$((PROMPT_WAITING + 1)) ;;
      *) OTHER_WAITING=$((OTHER_WAITING + 1)) ;;
    esac
    echo "boot-agents: $a monitor unconfirmed" >&2
  fi
done

# tmux quality-of-life (no-op if already set)
tmux_base set -g mouse on 2>/dev/null || true
tmux_base set -g set-titles on 2>/dev/null || true
tmux_base set -g set-titles-string "#{window_name}" 2>/dev/null || true
tmux_base set -g allow-passthrough on 2>/dev/null || true

echo "boot-agents: $LAUNCHED launched and ready, $ARMED monitors armed, $ALREADY_UP already up and ready, $WAITING waiting, $FAILED failed"
echo "boot-agents: waiting-detail: prompts=$PROMPT_WAITING other=$OTHER_WAITING"

BOOT_RC=0
[[ "$WAITING" -eq 0 ]] || BOOT_RC=3
[[ "$FAILED" -eq 0 ]] || BOOT_RC=1
if [[ "$ATTACH" -eq 1 ]]; then tmux_base attach -t "$SESSION"; fi
exit "$BOOT_RC"
