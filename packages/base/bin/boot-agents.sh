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
# RESUME-ON-RELAUNCH. A claude agent resumes with `claude --resume <name>`. A
# codex agent resumes the newest session belonging to its own workspace
# (codex_latest_session_for_workspace, below) with `codex resume <id>`.
# Without that, a codex agent starts genuinely fresh on every relaunch -- a
# crash, a manual restart, or an incidental relaunch as a side effect of some
# other agent's boot -- and silently loses its whole conversation. A genuine
# first boot, where no session exists for the workspace yet, starts fresh on
# every runtime, as it should.
#
# A codex resume is VERIFIED after sending (codex_verify_resume_or_fallback,
# below). A session id that was selected successfully is not a promise that
# `codex resume` accepts it: a corrupt session file, a CLI version
# incompatibility, or a session already locked elsewhere can drop the pane
# straight to a bare shell. That is strictly worse than having no resume at
# all, which at least always produced a live agent, so a pane that fails to
# come up as codex gets a fresh codex re-sent into it.
#
# The same verification window dismisses Codex's own "update available"
# dialog. Whenever a newer Codex release is published, every launch -- resume
# or first boot alike -- shows a blocking dialog waiting on a keystroke that a
# headless boot never sends, and because Codex is itself a node process the
# pane still reads as a live `node` while it sits there frozen.
#
# Classifying the launch outcome correctly is most of the difficulty, and the
# reasoning lives in codex_verify_resume_or_fallback's own header: a crash, an
# unobservable pane and a healthy-but-slow resume have to be told apart, and a
# session file is only ever quarantined on a positive observation that it
# actually failed.
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

# ---------------------------------------------------------------------------
# Codex resume-on-relaunch, and the update-dialog dismissal that shares its
# verification window. Everything from here down to the library boundary is
# pure functions, so the test suite can source this file and exercise them
# without a live tmux session or a live codex process.
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
#     (agent "wren" must not resume a session belonging to "wren-scratch").
#
# The id comes from the parsed payload, not from string-stripping the filename,
# so a change to Codex's filename format cannot quietly start yielding wrong
# ids. The filename is still load-bearing for the mtime scan itself, so the
# parsed id is cross-checked against the uuid suffix of the file it came from;
# a mismatch is treated as a malformed line and skipped like any other parse
# failure.
#
# CODEX_SESSIONS_DIR is the test seam: the suite points it at fixture
# directories instead of the real sessions directory.
codex_latest_session_for_workspace() {
  local a="$1" dir="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
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

# Indirection point so the test suite can stub the pane check without a live
# tmux target.
codex_pane_current_command() {
  tmux list-panes -t "$1" -F '#{pane_current_command}' 2>/dev/null
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
# codex_verify_resume_or_fallback below would read the pane as healthy while
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
codex_pane_has_update_dialog() {
  local pane="$1" tail_text
  tail_text=$(printf '%s\n' "$pane" | tail -n 20)
  printf '%s' "$tail_text" | grep -qF 'Update available!' || return 1
  printf '%s' "$tail_text" | grep -qF 'Press enter to continue'
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
# codex_verify_resume_or_fallback below). Every path returns explicitly rather
# than falling off the end of the function.
codex_dismiss_update_dialog_if_present() {
  local target="$1" pane
  pane="$(tmux capture-pane -t "$target" -p 2>/dev/null)"
  codex_pane_has_update_dialog "$pane" || return 1
  echo "boot-agents: codex update-available dialog detected on $target -- selecting 'Skip until next version' (3)" >&2
  tmux send-keys -t "$target" "3"
  return 0
}

# codex_verify_resume_or_fallback <target> <agent> <sid> <launch_flags> --
# confirm the pane actually came up, and recover it if it did not.
#
# A successful LOOKUP is not a successful RESUME. `codex resume <id>` can fail
# on a corrupt session file, a CLI version incompatibility, or a session
# already locked elsewhere, and when it does the pane drops to a bare shell and
# sits there dead -- worse than never resuming at all, which at least always
# produced a live agent. So after a settle wait the pane's running command is
# re-checked, and anything that is not codex/node gets a fresh codex re-sent
# into the same pane.
#
# The crash half is gated on a non-empty <sid>: a genuine first boot launched a
# plain codex and has no selected session to distrust. The DIALOG half above it
# is deliberately NOT gated that way. The update dialog is a property of Codex
# startup in general, not of resuming, so a first boot meets exactly the same
# dialog and needs exactly the same dismissal; gating it on <sid> would leave
# first-boot agents frozen. Folding it into the wait this function already does
# also means a codex launch pays one settle wait rather than two staggered
# ones, for what is in both cases "is this pane in a good state after we tried
# to launch it". Order matters too: while the dialog is up the pane already
# reads as a live `node`, so dismissing first means the crash check that
# follows is looking at the real post-dialog state rather than a false healthy
# masked by the same process.
#
# WHY THE POST-DISMISSAL CHECK IS A BOUNDED POLL. Dismissing the dialog proves
# only that the dialog is gone. It sits in FRONT of session loading, so the
# resume's real work may not have started until the keystroke landed a moment
# ago, and the same node process was alive throughout either way. A single
# check right after dismissal therefore proves nothing: a resume that is going
# to fail can still be mid-load at that instant, and once this function has
# returned "healthy" nothing ever catches the crash that lands a heartbeat
# later. That is precisely the selected-but-broken-resume outcome the whole
# mechanism exists to prevent, reintroduced through the dismissal path.
#
# POLL SHAPE. Up to CODEX_RESUME_POLL_MAX_CHECKS checks (default 10), each
# preceded by a CODEX_RESUME_POLL_INTERVAL_SECS sleep (default 1) so even the
# first check gets a settle beat after the keystroke, ending early the moment
# either outcome is confirmed:
#   - HEALTHY needs 3 CONSECUTIVE codex/node reads, not one. A crash in
#     progress can still show a transient live read on the very next check, so
#     a single good read is not evidence of stability.
#   - CRASH is any NON-EMPTY read that is not codex/node (`bash`, say): a
#     positive observation that the pane dropped to a shell. It fires the
#     fallback immediately rather than waiting the window out.
#   - INCONCLUSIVE is what is left. An EMPTY read means the pane could not be
#     observed at all; it counts toward neither outcome and RESETS the
#     consecutive-healthy streak, rather than being scored as a crash that was
#     never actually seen. If the window runs out with neither state confirmed,
#     this function does NOT return healthy. It logs a message worded
#     deliberately unlike the confirmed-crash one, so the two are tellable
#     apart in the boot log, then takes the same safe recovery. Declaring an
#     uncertain success is the one forbidden outcome.
#
# WHY THE POLL IS NOT UNCONDITIONAL. The no-dialog path's single check already
# sits after the full, uninterrupted settle wait: the resume had that entire
# window to stabilise or crash with nothing blocking it, which is exactly the
# condition the poll exists to manufacture for the dismissal path. Polling
# always would pay the extra latency on every codex boot for no additional
# safety on a path that is already covered.
#
# THE FALLBACK MUST CARRY THE SAME PREFIX AND FLAGS AS THE PRIMARY SEND. A
# crashed process takes its environment down with it, so a bare `codex`
# re-send would boot a nameless, unflagged agent: one that does not know which
# agent it is and does not honour the per-agent model override. The fallback is
# therefore built identically to the primary send, minus `resume <sid>`, and is
# issued from a single shared trailer used by all three ways into it (no-dialog
# crash, post-dismissal crash, post-dismissal inconclusive) so the three cannot
# drift apart.
#
# QUARANTINE, AND THE INVARIANTS THAT GATE IT. When a session genuinely fails
# to resume, its file is renamed -- never deleted, it is Codex's own data -- so
# the next boot stops re-selecting and re-failing on it. Getting that gate
# wrong is expensive in both directions: quarantining a healthy session
# silently regresses the next boot to an older conversation, which is the very
# continuity loss this whole mechanism exists to prevent.
#   1. A fallback send is worth ATTEMPTING whenever the trailer is reached at
#      all: a live replacement agent beats a frozen one, whether or not the
#      session turns out to be at fault.
#   2. On an INCONCLUSIVE outcome only, positively check that the tmux target
#      still exists (`tmux list-panes`, existence only, no format string)
#      before attempting anything. That is a different question from the
#      process-name read: an empty read there is ambiguous (a closed target, or
#      a live target having a transient hiccup), whereas list-panes failing is
#      a direct "this window is gone". A confirmed-gone target gets a
#      distinctly worded escalation, no send, and no file touched. A target
#      that still exists falls through to the same path a confirmed crash
#      takes.
#   3. The rename requires BOTH a successful send AND outcome == "crash". Send
#      success alone is necessary but never sufficient: tmux's exit status
#      answers "did tmux accept keys somewhere", and nothing about whether THIS
#      session was ever at fault. Target existence answers "is there somewhere
#      to send", which is not that question either. Only a positive observation
#      of a non-codex/node process indicts the session, so the file survives in
#      every case except the one where both conditions hold.
#
# RECREATING A LOST WINDOW IS DELIBERATELY OUT OF SCOPE. Creating tmux windows
# belongs to launch_agent, which already knows the right name, working
# directory and session; duplicating a slice of that here invites the two
# drifting apart. Recreating a window out from under a boot that is already
# mid-verification is also a bigger decision than a verification step should be
# making on its own, since the window may have been closed deliberately. A
# clearly worded escalation is the conservative stop: it surfaces the problem
# for whoever is looking, and the next run of this script creates the window
# again through launch_agent's own existing path.
#
# TEST SEAMS: CODEX_RESUME_VERIFY_SECS (set 0 to skip the settle wait, shared
# by the dialog check and the no-dialog crash check) and
# CODEX_RESUME_POLL_INTERVAL_SECS (set 0 to skip the poll's sleeps while still
# running the real CODEX_RESUME_POLL_MAX_CHECKS iterations of check logic).
codex_verify_resume_or_fallback() {
  local target="$1" a="$2" sid="$3" launch_flags="${4:-}" wait_secs="${CODEX_RESUME_VERIFY_SECS:-5}"
  [[ "$wait_secs" -gt 0 ]] 2>/dev/null && sleep "$wait_secs"

  local dismissed=1
  codex_dismiss_update_dialog_if_present "$target" && dismissed=0

  [[ -n "$sid" ]] || return 0

  # cmd is initialised because the inconclusive message reads it back, and a
  # zero-length poll window would otherwise leave it unset under `set -u`.
  local cmd="" fallback_reason="" outcome="crash"
  if [[ "$dismissed" -eq 0 ]]; then
    # Post-dismissal: a bounded poll, not a single immediate check. See "WHY
    # THE POST-DISMISSAL CHECK IS A BOUNDED POLL" above.
    local interval="${CODEX_RESUME_POLL_INTERVAL_SECS:-1}" max_checks="${CODEX_RESUME_POLL_MAX_CHECKS:-10}"
    local i=0 consecutive=0
    while [[ "$i" -lt "$max_checks" ]]; do
      [[ "$interval" -gt 0 ]] 2>/dev/null && sleep "$interval"
      cmd="$(codex_pane_current_command "$target")"
      if echo "$cmd" | grep -qiE 'codex|node'; then
        consecutive=$((consecutive + 1))
        [[ "$consecutive" -ge 3 ]] && return 0
      elif [[ -n "$cmd" ]]; then
        fallback_reason="$a's codex resume $sid landed on '$cmd' after the update-dialog dismissal, not codex/node -- falling back to a fresh codex"
        outcome="crash"
        break
      else
        consecutive=0
      fi
      i=$((i + 1))
    done
    if [[ -z "$fallback_reason" ]]; then
      # Inconclusive, not a confirmed crash. Deliberately does not say
      # "falling back to a fresh codex" the way the crash wording does:
      # whether a fallback is even attempted is decided below, after the
      # target-existence check this outcome alone triggers.
      fallback_reason="$a's codex resume $sid could not be confirmed healthy within the post-dialog poll window (last read: '$cmd') -- treating as inconclusive, not a false success"
      outcome="inconclusive"
    fi
  else
    # No dialog was shown, so the resume had the whole settle wait
    # uninterrupted and one check is enough -- but only a NON-EMPTY,
    # non-codex/node read is evidence of a crash. An empty read here is
    # exactly as ambiguous as an empty read inside the poll, so it is
    # classified inconclusive and routed through the same target-existence
    # check below; that check keys on $outcome alone, so it needs no separate
    # logic. Classifying an empty read as a crash would let a single transient
    # hiccup quarantine a healthy session on no evidence at all, through a
    # one-check window instead of the poll's ten.
    cmd="$(codex_pane_current_command "$target")"
    if echo "$cmd" | grep -qiE 'codex|node'; then
      return 0
    fi
    if [[ -z "$cmd" ]]; then
      fallback_reason="$a's codex resume $sid produced an EMPTY process read (no dialog was dismissed on this path) -- zero positive evidence of a crash, treating as inconclusive rather than assuming failure"
      outcome="inconclusive"
    else
      fallback_reason="$a's codex resume $sid landed on '$cmd', not codex/node -- falling back to a fresh codex"
      outcome="crash"
    fi
  fi

  echo "boot-agents: $fallback_reason" >&2

  if [[ "$outcome" == "inconclusive" ]]; then
    # Invariant 2: positively check the tmux target exists before considering
    # a fallback send at all. An inconclusive result is evidence the pane
    # could not be observed, never evidence the session was bad.
    if ! tmux list-panes -t "$target" >/dev/null 2>&1; then
      echo "boot-agents: $a's tmux target $target could not be located at all (tmux list-panes failed) after an inconclusive check on $sid -- the window itself is very likely gone, not just the codex session inside it. Not attempting a fallback send into a target that does not exist, and not touching $sid's session file (zero evidence the session was at fault). Escalating so an operator, or a later run of this script, recreates the window; this function does not create tmux windows itself." >&2
      return 1
    fi
    # The target exists, so the empty reads were something else -- a race, a
    # transient tmux hiccup -- and a fallback attempt is still worth making.
    # Falls through to the same send-then-maybe-quarantine path a confirmed
    # crash takes; invariant 3 governs both identically from here.
  fi

  # Invariant 1: attempt the fallback whatever the outcome, built identically
  # to the primary send minus `resume <sid>` so the replacement agent keeps
  # its name and its flags.
  tmux send-keys -t "$target" "printf '\033]0;${a}\007'; AGENT_NAME=$a codex $launch_flags" Enter
  local send_rc=$?
  if [[ "$send_rc" -ne 0 ]]; then
    echo "boot-agents: $a's fallback codex re-send into $target itself FAILED (tmux send-keys exited $send_rc) -- the target is likely gone too, a worse problem than a bad session. Not quarantining $sid: the fallback never landed, and there is still no positive evidence the session was at fault. Escalating for an operator." >&2
    return 1
  fi

  # Invariant 3: the rename needs BOTH a successful send AND a positively
  # observed crash. A successful send proves tmux delivered a keystroke to a
  # real pane, and nothing whatsoever about whether this session was at fault.
  if [[ "$outcome" != "crash" ]]; then
    echo "boot-agents: $a's fallback codex re-send into $target succeeded, but $sid is NOT being quarantined -- the check never positively observed a crash, only an inconclusive window with an existing target, and a successful send proves nothing about whether the session was at fault. Preserving $sid." >&2
    return 1
  fi

  local dir="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}" bad
  bad=$(find "$dir" -type f -name "*-${sid}.jsonl" 2>/dev/null | head -1)
  [[ -n "$bad" ]] && mv -f -- "$bad" "${bad}.codex-resume-failed" 2>/dev/null
  return 1
}

# --- library boundary: the test suite sources this file with
# BOOT_AGENTS_LIB_ONLY=1 to reach the functions above without running any of
# the live tmux work below. Nothing past this point executes in that mode.
if [[ "${BOOT_AGENTS_LIB_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

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
    #
    # `--resume <name>` resolves a session DISPLAY NAME, and a session only
    # acquires one when someone runs `/rename <name>` inside it. A brand new
    # agent has none, so its very first boot fails with "No conversations found
    # to resume", leaving a pane with no agent in it, which the idempotency
    # check above then re-attempts on every subsequent run. Hence the fallback
    # to a plain launch: the first boot starts a fresh session, and once that
    # session has been renamed, every later boot resumes it. Run
    # `/rename <name>` in a new agent's first session.
    tmux send-keys -t "$target" "printf '\033]0;${a}\007'; [ -f $AGENTS_HOME/$a/.env.secrets ] && . $AGENTS_HOME/$a/.env.secrets; claude --resume $a $model_flag || claude $model_flag" Enter
  elif [[ "$runtime" == "codex" ]]; then
    # Resume this agent's own most recent conversation, workspace-scoped
    # (codex_latest_session_for_workspace, above). Always an explicit id
    # rather than `codex resume --last`: the filters that make the choice
    # correct here -- an interactive session, started by a person, in this
    # agent's own workspace -- are this script's, and leaning on the CLI's own
    # most-recent semantics would hand that decision away. An empty id means
    # no session exists for this workspace yet, i.e. a genuine first boot, and
    # a plain codex is exactly right.
    local sid; sid="$(codex_latest_session_for_workspace "$a")"
    local codex_cmd="codex $model_flag"
    [[ -n "$sid" ]] && codex_cmd="codex resume $sid $model_flag"
    tmux send-keys -t "$target" "printf '\033]0;${a}\007'; AGENT_NAME=$a $codex_cmd" Enter
    # A selected id is not a promise the resume succeeded, so verify the pane
    # and recover it if it did not come up (codex_verify_resume_or_fallback,
    # above). The same call dismisses Codex's update-available dialog, which
    # is deliberately not gated on $sid so a first boot gets it too.
    codex_verify_resume_or_fallback "$target" "$a" "$sid" "$model_flag"
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
