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
# Usage:
#   bin/boot-agents.sh                 # resume + arm all agents, stay headless
#   bin/boot-agents.sh --attach        # same, then attach to the session
#   bin/boot-agents.sh wren basalt     # only the named agents
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

# Per-agent runtime (claude default; override via $AGENTS_HOME/<name>/.runtime).
get_runtime() {
  local a="$1"
  [[ -f "$AGENTS_HOME/$a/.runtime" ]] && cat "$AGENTS_HOME/$a/.runtime" || echo "claude"
}

tmux start-server 2>/dev/null || true
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -n "${AGENTS[0]}" -c "$AGENTS_HOME/${AGENTS[0]}"
fi

# Launch an agent if it is not already running. Echoes "launched" or "skipped".
launch_agent() {
  local a="$1" target="$SESSION:$1" runtime model_flag=""
  runtime=$(get_runtime "$a")
  # Per-agent model override (selector): $AGENTS_HOME/<a>/.model -> --model flag.
  # Absent = no flag = inherit the global default.
  [[ -f "$AGENTS_HOME/$a/.model" ]] && model_flag="--model $(cat "$AGENTS_HOME/$a/.model")"
  tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$a" \
    || tmux new-window -t "$SESSION" -n "$a" -c "$AGENTS_HOME/$a"
  if tmux list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null | grep -qiE 'claude|node'; then
    echo "skipped"; return
  fi
  if [[ "$runtime" == "claude" ]]; then
    # Source the agent's gitignored .env.secrets (if any) in the pane shell
    # before launching claude, so anything referencing a live secret via
    # ${VAR} resolves. Secrets should come from a real secret store at boot,
    # never raw in git-tracked config.
    tmux send-keys -t "$target" "printf '\033]0;${a}\007'; [ -f $AGENTS_HOME/$a/.env.secrets ] && . $AGENTS_HOME/$a/.env.secrets; claude --resume $a $model_flag" Enter
  else
    # Any other runtime: launch it plainly. If it needs env vars set before
    # the process starts rather than after, set them here explicitly -- some
    # runtimes only apply hook-declared env to their own shell tool calls, not
    # to the process itself, so a hook-only approach can silently under-scope.
    tmux send-keys -t "$target" "printf '\033]0;${a}\007'; AGENT_NAME=$a $runtime $model_flag" Enter
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
for a in "${AGENTS[@]}"; do
  if [[ "$(launch_agent "$a")" == "launched" ]]; then
    FRESH+=("$a")
    [[ "$STAGGER_SECS" -gt 0 ]] && sleep "$STAGGER_SECS"
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

# Auto-arm the watcher on freshly-launched, opt-in agents. Wait for the TUI to
# be ready, then type the prompt. Adjust "arm your monitor" to whatever your
# own watcher-arming instruction is.
for a in "${FRESH[@]}"; do
  should_auto_arm "$a" || continue
  target="$SESSION:$a"
  # wait up to ~45s for the runtime to be the running command in the pane
  for _ in $(seq 1 45); do
    tmux list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null | grep -qiE 'claude|node' && break
    sleep 1
  done
  sleep 6  # extra settle so the input box is ready to accept keys
  # text and Enter sent separately: one send-keys call carrying both text and
  # Enter can race a TUI that hasn't finished drawing its composer yet.
  tmux send-keys -t "$target" "arm your monitor"
  sleep 0.7
  tmux send-keys -t "$target" Enter
done

# Verify each fresh agent actually started its watcher, and re-send if it
# missed (a resume can land mid-compaction, or a slow TUI can drop the keys).
# Up to a few retries makes the arm self-healing.
for a in "${FRESH[@]}"; do
  should_auto_arm "$a" || continue
  target="$SESSION:$a"
  for _ in 1 2 3 4; do
    sleep 8
    tmux capture-pane -t "$target" -p 2>/dev/null \
      | grep -qiE 'Monitor\(|inbox events|Monitor started' && break
    tmux send-keys -t "$target" "arm your monitor"
    sleep 0.7
    tmux send-keys -t "$target" Enter
  done
done

# tmux quality-of-life (no-op if already set)
tmux set -g mouse on 2>/dev/null || true
tmux set -g set-titles on 2>/dev/null || true
tmux set -g set-titles-string "#{window_name}" 2>/dev/null || true
tmux set -g allow-passthrough on 2>/dev/null || true

echo "boot-agents: ${#FRESH[@]} launched + armed (${FRESH[*]:-none}), $(( ${#AGENTS[@]} - ${#FRESH[@]} )) already up"

[[ $ATTACH -eq 1 ]] && exec tmux attach -t "$SESSION"
exit 0
