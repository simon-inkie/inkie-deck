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

get_runtime() {
  local agent="$1"
  if [[ -n "$RUNTIME_OVERRIDE" ]]; then
    echo "$RUNTIME_OVERRIDE"
  elif [[ -f "$AGENTS_HOME/$agent/.runtime" ]]; then
    cat "$AGENTS_HOME/$agent/.runtime"
  else
    echo "claude"
  fi
}

start_agent() {
  local agent="$1"
  local target="$SESSION:$agent"
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
    tmux send-keys -t "$target" "printf '\\033]0;${agent}\\007'; [ -f $AGENTS_HOME/$agent/.env.secrets ] && . $AGENTS_HOME/$agent/.env.secrets; claude $session_args $model_flag $(claude_first_boot_prompt "$session_args" "$AGENTS_HOME/$agent")" Enter
  else
    # Any other runtime: launch it plainly and let its own config (hooks,
    # AGENT_NAME wiring) do the rest. Add a branch here if a given runtime
    # needs env vars set before the process starts rather than after -- some
    # runtimes only apply hook-declared env to their own shell tool calls, not
    # to the process itself, so a hook-only approach can silently under-scope.
    tmux send-keys -t "$target" "printf '\\033]0;${agent}\\007'; AGENT_NAME=$agent $runtime $model_flag" Enter
  fi
}

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
  tmux split-window -d -t "$target" -h -p 15 "exec $WATCHER_SCRIPT $target" 2>/dev/null || true
}

# Create the base session if it doesn't exist
# Before any pane starts, so Claude Code shows no "focus-events off" hint.
tmux start-server 2>/dev/null || true
tmux set -g focus-events on 2>/dev/null || true
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  FIRST="${AGENTS[0]}"
  tmux new-session -d -s "$SESSION" -n "$FIRST" -c "$AGENTS_HOME/$FIRST"
  start_agent "$FIRST"
  start_watcher "$FIRST"

  for agent in "${AGENTS[@]:1}"; do
    tmux new-window -t "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
    start_agent "$agent"
    start_watcher "$agent"
  done
fi

# Enable mouse scroll + click, and terminal title passthrough
# (must be after session exists -- tmux server has to be running)
tmux set -g mouse on 2>/dev/null || true
tmux set -g set-titles on 2>/dev/null || true
tmux set -g set-titles-string "#{window_name}" 2>/dev/null || true
tmux set -g allow-passthrough on 2>/dev/null || true

# Add any missing agent windows
for agent in "${AGENTS[@]}"; do
  if ! tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx "$agent"; then
    tmux new-window -t "$SESSION" -n "$agent" -c "$AGENTS_HOME/$agent"
    start_agent "$agent"
    start_watcher "$agent"
  fi
done

if [[ $WINDOWED -eq 1 ]]; then
  # Spawn each agent in its own Windows Terminal window via wt.exe (WSL only).
  # Each window attaches to the shared tmux session and selects its agent.
  # Use bash -c so the tmux command separator (\;) survives the
  # wt.exe -> wsl.exe -> bash argument chain intact.
  for agent in "${AGENTS[@]}"; do
    wt.exe -w new --title "$agent" \
      wsl.exe -d Ubuntu --cd "$AGENTS_HOME/$agent" -- \
      bash -c "tmux new-session -t $SESSION \\; select-window -t $agent" \
      >/dev/null 2>&1 &
    sleep 0.5  # stagger so wt.exe instances don't race each other
  done
  wait  # let backgrounded wt.exe calls settle
  echo "Spawned ${#AGENTS[@]} windowed agents"
else
  # Attach via a grouped session: shares windows but keeps independent focus
  # per client, so two people (or two terminals) can look at different agents
  # in the same tmux session at once.
  LAST_AGENT="${AGENTS[-1]}"
  exec tmux new-session -t "$SESSION" \; select-window -t "$LAST_AGENT"
fi
