#!/usr/bin/env bash
# Tests for bin/boot-agents.sh -- specifically its codex resume-on-relaunch
# machinery: codex_latest_session_for_workspace (the session lookup),
# codex_pane_has_update_dialog / codex_dismiss_update_dialog_if_present (the
# update-dialog detector and its keystroke), and
# codex_verify_resume_or_fallback (launch verification, recovery, and the
# quarantine gate).
#
#   bash packages/base/test/boot-agents.test.sh
#     -> prints PASS/FAIL per case, exits non-zero on any fail.
#
# NO LIVE TMUX, NO LIVE CODEX, and no real sessions directory is ever read or
# written. Session fixtures live under a scratch CODEX_SESSIONS_DIR; the pane
# check and tmux itself are stubbed. boot-agents.sh is sourced with
# BOOT_AGENTS_LIB_ONLY=1, which stops it at the library boundary before any
# live tmux call, so this suite only ever gets the functions and never the boot
# sequence.
#
# AGENTS_HOME is pointed at a scratch tree holding two demo agents. That is not
# decoration: the lookup filters on "cwd" == "$AGENTS_HOME/<agent>", so the
# suite has to own that value to be able to write fixtures that match it.
#
# Fixtures are real captured shapes with the identifying text replaced -- the
# same discipline pane-idle.test.sh states for its own dialog fixtures. Their
# SHAPE is the thing under test: the lookup's greps depend on the no-space
# `"key":"value"` formatting, and the detector depends on where the dialog
# renders in the pane.
set +e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Grade the boot-agents.sh belonging to THIS checkout, not whichever copy the
# machine happens to have installed -- the same lesson inbox-push.test.sh
# already learned with INBOX_PUSH_BIN. BOOT_AGENTS_BIN overrides.
BIN="${BOOT_AGENTS_BIN:-$(cd "$HERE/../bin" && pwd)/boot-agents.sh}"

BOX="$(mktemp -d)"
trap 'rm -rf "$BOX"' EXIT
mkdir -p "$BOX/homes/basalt" "$BOX/homes/wren"
: > "$BOX/homes/basalt/SOUL.md"
: > "$BOX/homes/wren/SOUL.md"
printf 'codex\n' > "$BOX/homes/basalt/.runtime"
export AGENTS_HOME="$BOX/homes"

# Clear positional parameters before sourcing: a sourced script sees the
# caller's, and boot-agents.sh parses them as its own flags.
set --
BOOT_AGENTS_LIB_ONLY=1 . "$BIN"

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }

if [ -z "${AGENTS_HOME:-}" ] || ! declare -F codex_latest_session_for_workspace >/dev/null; then
  echo "FAIL  library did not load from $BIN"
  echo "boot-agents: 0 passed, 1 failed"
  exit 1
fi
pass "library sources cleanly under BOOT_AGENTS_LIB_ONLY"

# ---- fixture machinery -----------------------------------------------------
# A session_meta first line with every field the lookup reads
# (cwd/originator/thread_source/id/session_id) kept in its real structure and
# real ordering, and everything identifying replaced with a placeholder mkfix
# substitutes. The long base_instructions text is trimmed: nothing reads it,
# and its real length only makes the fixture unreadable.
TEMPLATE='{"timestamp":"2026-01-02T15:47:44.003Z","ordinal":0,"type":"session_meta","payload":{"session_id":"__ID__","id":"__ID__","timestamp":"2026-01-02T15:47:43.663Z","cwd":"__CWD__","originator":"__ORIGINATOR__","cli_version":"0.149.1","source":"cli","thread_source":"__THREAD_SOURCE__","model_provider":"openai","base_instructions":{"text":"[trimmed for the fixture: real field, real length not needed]"},"history_mode":"paginated","context_window":{"window_id":"99999999-9999-9999-9999-999999999999"}}}'

# mkfix <fixdir> <filename_ts> <filename_id> <payload_id> <cwd> <originator> <thread_source> <mtime_epoch>
# Writes a fixture whose line 1 is TEMPLATE with the placeholders filled in,
# named rollout-<filename_ts>-<filename_id>.jsonl, mtime forced to <mtime_epoch>.
# filename_id and payload_id are separate arguments on purpose: the lookup
# cross-checks one against the other, so a test needs to be able to disagree
# them.
mkfix() {
  local fixdir="$1" fts="$2" fid="$3" pid="$4" cwd="$5" orig="$6" tsrc="$7" mtime="$8"
  local out="$fixdir/rollout-${fts}-${fid}.jsonl"
  printf '%s\n' "$TEMPLATE" \
    | sed -e "s#__CWD__#$cwd#" \
          -e "s#__ORIGINATOR__#$orig#" \
          -e "s#__THREAD_SOURCE__#$tsrc#" \
          -e "s#__ID__#$pid#g" \
    > "$out"
  touch -d "@$mtime" "$out"
  printf '%s\n' "$out"
}

NOW=$(date +%s)
BASALT_CWD="$AGENTS_HOME/basalt"

# ===== the session lookup ===================================================

# T1: newest matching session by mtime wins.
T1_DIR=$(mktemp -d)
mkfix "$T1_DIR" 2026-01-01T10-00-00 old11111-1111-1111-1111-111111111111 old11111-1111-1111-1111-111111111111 "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
mkfix "$T1_DIR" 2026-01-02T10-00-00 new22222-2222-2222-2222-222222222222 new22222-2222-2222-2222-222222222222 "$BASALT_CWD" codex-tui user $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T1_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "new22222-2222-2222-2222-222222222222" ] \
  && pass "T1 newest-mtime match wins" \
  || fail "T1 newest-mtime match wins" "got '$got'"
rm -rf "$T1_DIR"

# T2: a newer session in ANOTHER agent's workspace is skipped, and the older
# match is used instead. Without the cwd filter this agent would resume a
# different agent's conversation.
T2_DIR=$(mktemp -d)
mkfix "$T2_DIR" 2026-01-01T10-00-00 old33333-3333-3333-3333-333333333333 old33333-3333-3333-3333-333333333333 "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
mkfix "$T2_DIR" 2026-01-02T10-00-00 new44444-4444-4444-4444-444444444444 new44444-4444-4444-4444-444444444444 "$AGENTS_HOME/wren" codex-tui user $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T2_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "old33333-3333-3333-3333-333333333333" ] \
  && pass "T2 skips a newer session in another workspace" \
  || fail "T2 skips a newer session in another workspace" "got '$got'"
rm -rf "$T2_DIR"

# T3: a non-interactive run is skipped in favour of a real interactive session.
T3_DIR=$(mktemp -d)
mkfix "$T3_DIR" 2026-01-01T10-00-00 old55555-5555-5555-5555-555555555555 old55555-5555-5555-5555-555555555555 "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
mkfix "$T3_DIR" 2026-01-02T10-00-00 new66666-6666-6666-6666-666666666666 new66666-6666-6666-6666-666666666666 "$BASALT_CWD" codex_exec user $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T3_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "old55555-5555-5555-5555-555555555555" ] \
  && pass "T3 skips a non-interactive originator" \
  || fail "T3 skips a non-interactive originator" "got '$got'"
rm -rf "$T3_DIR"

# T4: a subagent thread is skipped in favour of the user's own thread.
T4_DIR=$(mktemp -d)
mkfix "$T4_DIR" 2026-01-01T10-00-00 old77777-7777-7777-7777-777777777777 old77777-7777-7777-7777-777777777777 "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
mkfix "$T4_DIR" 2026-01-02T10-00-00 new88888-8888-8888-8888-888888888888 new88888-8888-8888-8888-888888888888 "$BASALT_CWD" codex-tui subagent $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T4_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "old77777-7777-7777-7777-777777777777" ] \
  && pass "T4 skips a subagent thread" \
  || fail "T4 skips a subagent thread" "got '$got'"
rm -rf "$T4_DIR"

# T5: an empty sessions directory yields nothing, and does not crash.
T5_DIR=$(mktemp -d)
got=$(CODEX_SESSIONS_DIR="$T5_DIR" codex_latest_session_for_workspace basalt)
[ -z "$got" ] \
  && pass "T5 empty sessions dir -> empty" \
  || fail "T5 empty sessions dir -> empty" "got '$got'"
rm -rf "$T5_DIR"

# T5b: a sessions directory that does not exist at all yields nothing, and does
# not crash. This is the ordinary state before an agent's first codex launch.
got=$(CODEX_SESSIONS_DIR="$BOX/no-such-sessions-dir" codex_latest_session_for_workspace basalt)
[ -z "$got" ] \
  && pass "T5b missing sessions dir -> empty" \
  || fail "T5b missing sessions dir -> empty" "got '$got'"

# T6: a malformed first line on the newest file is skipped, and the next
# candidate down wins.
T6_DIR=$(mktemp -d)
mkfix "$T6_DIR" 2026-01-01T10-00-00 ok999999-9999-9999-9999-999999999999 ok999999-9999-9999-9999-999999999999 "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
BAD_F="$T6_DIR/rollout-2026-01-02T10-00-00-badaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl"
printf 'not even close to a session_meta json line\n' > "$BAD_F"
touch -d "@$((NOW - 100))" "$BAD_F"
got=$(CODEX_SESSIONS_DIR="$T6_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "ok999999-9999-9999-9999-999999999999" ] \
  && pass "T6 malformed first line skipped, next candidate wins" \
  || fail "T6 malformed first line skipped, next candidate wins" "got '$got'"
rm -rf "$T6_DIR"

# T7: the cwd match runs through the closing quote, so a shorter agent name
# cannot match a longer one that starts with it.
T7_DIR=$(mktemp -d)
mkfix "$T7_DIR" 2026-01-01T10-00-00 fx111111-1111-1111-1111-111111111111 fx111111-1111-1111-1111-111111111111 "$AGENTS_HOME/basalt-scratch" codex-tui user $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T7_DIR" codex_latest_session_for_workspace basalt)
[ -z "$got" ] \
  && pass "T7 'basalt' does not match 'basalt-scratch'" \
  || fail "T7 'basalt' does not match 'basalt-scratch'" "got '$got'"
rm -rf "$T7_DIR"

# T8: a parsed id that disagrees with its own filename's uuid is treated as
# malformed and skipped, and the older agreeing candidate wins.
T8_DIR=$(mktemp -d)
mkfix "$T8_DIR" 2026-01-01T10-00-00 goodaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa goodaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa "$BASALT_CWD" codex-tui user $((NOW - 200)) >/dev/null
mkfix "$T8_DIR" 2026-01-02T10-00-00 filename-bbbb-bbbb-bbbb-bbbbbbbbbbbb payloadid-cccc-cccc-cccc-cccccccccccc "$BASALT_CWD" codex-tui user $((NOW - 100)) >/dev/null
got=$(CODEX_SESSIONS_DIR="$T8_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "goodaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" ] \
  && pass "T8 parsed-id/filename mismatch skipped as malformed" \
  || fail "T8 parsed-id/filename mismatch skipped as malformed" "got '$got'"
rm -rf "$T8_DIR"

# T9: a session whose first line is perfectly well formed but whose CONTENT is
# truncated is still SELECTED by the lookup. That is correct and deliberate:
# the lookup only ever reads line 1, and catching a resume that then fails is
# codex_verify_resume_or_fallback's job, one layer up. This pins where the
# responsibility boundary sits.
T9_DIR=$(mktemp -d)
BADSID="deadbeef-dead-beef-dead-beefdeadbeef"
mkfix "$T9_DIR" 2026-01-03T10-00-00 "$BADSID" "$BADSID" "$BASALT_CWD" codex-tui user $((NOW - 50)) >/dev/null
printf 'TRUNCATED-CORRUPT-CONTENT-NOT-VALID-JSONL\n' >> "$T9_DIR/rollout-2026-01-03T10-00-00-${BADSID}.jsonl"
got=$(CODEX_SESSIONS_DIR="$T9_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "$BADSID" ] \
  && pass "T9 lookup still selects a session that is bad beyond line 1" \
  || fail "T9 lookup still selects a session that is bad beyond line 1" "got '$got'"

# ===== launch verification and recovery =====================================
# The pane check and tmux are stubbed so no live target is needed. TMUX_LOG
# records every send-keys call for assertion.
#
# MODEL_FLAG stands in for whatever the primary send carried beyond the bare
# command. The fallback has to reproduce it exactly, because a crashed process
# takes its environment and its flags down with it, and a bare re-send would
# boot a nameless agent ignoring its own model override.
MODEL_FLAG="--model gpt-5.6"
# One shared matcher for the fallback re-send, rather than the same regex
# copied into eight assertions where seven of them could quietly drift.
resend_logged() {
  grep -qE "send-keys -t test:basalt printf .*basalt.*; AGENT_NAME=basalt codex --model gpt-5\.6 Enter" "$1"
}

TMUX_LOG=$(mktemp)
tmux() {
  if [ "$1" = "send-keys" ]; then printf '%s\n' "$*" >> "$TMUX_LOG"; fi
  return 0
}
export CODEX_RESUME_VERIFY_SECS=0        # test seam: skip the settle wait
export CODEX_RESUME_POLL_INTERVAL_SECS=0 # test seam: skip the poll's sleeps, while
                                         # leaving CODEX_RESUME_POLL_MAX_CHECKS at its
                                         # real default so the poll cases below still
                                         # run the production check COUNT, not a
                                         # scaled-down stand-in.
CODEX_SESSIONS_DIR="$T9_DIR"             # so the quarantine step finds T9's fixture

# T10: the pane came up as a running codex/node process. No fallback.
codex_pane_current_command() { printf 'node\n'; }
: > "$TMUX_LOG"
codex_verify_resume_or_fallback "test:basalt" basalt "$BADSID" "$MODEL_FLAG"
rc=$?
sent=$(grep -c 'send-keys' "$TMUX_LOG" 2>/dev/null)
if [ "$rc" -eq 0 ] && [ "$sent" -eq 0 ]; then
  pass "T10 healthy resume: no fallback fires"
else
  fail "T10 healthy resume: no fallback fires" "rc=$rc sent=$sent"
fi

# T11 (the headline crash case): the pane dropped to a bare shell after the
# resume. A fresh codex must be re-sent into the SAME pane carrying the SAME
# name and flags as the primary send, and the bad session file must be renamed
# rather than deleted, so the next boot stops re-selecting it.
codex_pane_current_command() { printf 'bash\n'; }
: > "$TMUX_LOG"
codex_verify_resume_or_fallback "test:basalt" basalt "$BADSID" "$MODEL_FLAG"
rc=$?
resend_ok=0
resend_logged "$TMUX_LOG" && resend_ok=1
renamed_ok=0
[ -f "$T9_DIR/rollout-2026-01-03T10-00-00-${BADSID}.jsonl.codex-resume-failed" ] && renamed_ok=1
orig_gone=0
[ ! -f "$T9_DIR/rollout-2026-01-03T10-00-00-${BADSID}.jsonl" ] && orig_gone=1
if [ "$rc" -ne 0 ] && [ "$resend_ok" -eq 1 ] && [ "$renamed_ok" -eq 1 ] && [ "$orig_gone" -eq 1 ]; then
  pass "T11 crashed resume: fully-flagged codex re-sent, bad session renamed"
else
  fail "T11 crashed resume: fully-flagged codex re-sent, bad session renamed" \
    "rc=$rc resend_ok=$resend_ok renamed_ok=$renamed_ok orig_gone=$orig_gone"
fi
rm -rf "$T9_DIR" "$TMUX_LOG"
unset CODEX_SESSIONS_DIR

# T12: an empty sid means a genuine first boot, so nothing was resumed and
# there is nothing to distrust. The crash half is a no-op whatever the pane
# shows.
codex_pane_current_command() { printf 'bash\n'; }
TMUX_LOG2=$(mktemp)
tmux() { if [ "$1" = "send-keys" ]; then printf '%s\n' "$*" >> "$TMUX_LOG2"; fi; return 0; }
codex_verify_resume_or_fallback "test:basalt" basalt "" "$MODEL_FLAG"
rc=$?
sent2=$(grep -c 'send-keys' "$TMUX_LOG2" 2>/dev/null)
if [ "$rc" -eq 0 ] && [ "$sent2" -eq 0 ]; then
  pass "T12 empty sid (first boot): the crash check is a no-op"
else
  fail "T12 empty sid (first boot): the crash check is a no-op" "rc=$rc sent=$sent2"
fi
rm -f "$TMUX_LOG2"

# ===== the update-available dialog ==========================================
# Both fixtures are real captured pane shapes. CODEX_UPDATE_DIALOG is the
# blocking dialog as it renders on a launch with a newer release published;
# CODEX_UPDATE_STATIC_BANNER is the non-blocking reminder banner Codex prints
# on every launch AFTER the dialog has been answered once. The second is the
# real false positive the two-anchor rule exists to reject, which is why it is
# a fixture and not a hypothetical.
CODEX_UPDATE_DIALOG=$'
  ✨ Update available! 0.149.1 -> 0.153.0

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version

  Press enter to continue'
CODEX_UPDATE_STATIC_BANNER=$'╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.149.1 -> 0.153.0         │
│ Run npm install -g @openai/codex to update.     │
│                                                 │
│ See full release notes:                         │
│ https://github.com/openai/codex/releases/latest │
╰─────────────────────────────────────────────────╯'

# ---- the detector ----------------------------------------------------------

# D1 (positive): the real blocking dialog.
if codex_pane_has_update_dialog "$CODEX_UPDATE_DIALOG"; then
  pass "D1 detector: live update-available dialog -> yes"
else fail "D1 detector: live update-available dialog -> yes"; fi

# D2 (negative, the false positive the pairing exists to reject): the static
# post-dismissal banner carries the headline but never the confirm footer, and
# blocks nothing. Matching the headline alone would fire on this harmless
# banner on every boot once the dialog had been answered once.
if codex_pane_has_update_dialog "$CODEX_UPDATE_STATIC_BANNER"; then
  fail "D2 detector: static post-dismissal banner -> no" "matched the harmless banner"
else pass "D2 detector: static post-dismissal banner -> no"; fi

# D3 (negative, tail anchoring): both anchor strings appear, but only quoted in
# transcript text pushed above the tail window, with an idle composer at the
# very bottom. A whole-pane substring test would misfire on any agent that
# discussed this dialog.
D3_FILLER=$(for _i in $(seq 1 24); do printf '  ... transcript line %s\n' "$_i"; done)
CODEX_DIALOG_QUOTED_IN_PROSE=$'I saw: "Update available! 0.149.1 -> 0.153.0" then "Press enter to continue".\n'"$D3_FILLER"$'\n\xe2\x80\xba Ask Codex to do anything'
if codex_pane_has_update_dialog "$CODEX_DIALOG_QUOTED_IN_PROSE"; then
  fail "D3 detector: both anchors quoted in text, pushed off-tail -> no" "matched a stale quote"
else pass "D3 detector: both anchors quoted in text, pushed off-tail -> no"; fi

# D4: an ordinary idle pane, and an empty capture.
if codex_pane_has_update_dialog $'some transcript\n\n\xe2\x80\xba Ask Codex to do anything'; then
  fail "D4 detector: ordinary idle pane -> no"; else pass "D4 detector: ordinary idle pane -> no"; fi
if codex_pane_has_update_dialog ""; then
  fail "D4b detector: empty capture -> no"; else pass "D4b detector: empty capture -> no"; fi

# ---- the keystroke ---------------------------------------------------------
# Stubs the tmux subcommands this section needs: capture-pane returns a
# controlled fixture, send-keys is logged, and list-panes answers the
# target-existence check the inconclusive branch makes. send-keys and
# list-panes get controllable exit codes via SEND_KEYS_RC / LIST_PANES_RC
# (both defaulting to success, and only set by the cases that need a failure)
# so the send-success and target-existence gates are exercisable without a live
# tmux target.
DIALOG_STUB_TEXT=""
TMUX_LOG3=$(mktemp)
tmux() {
  case "$1" in
    send-keys) printf '%s\n' "$*" >> "$TMUX_LOG3"; return "${SEND_KEYS_RC:-0}" ;;
    capture-pane) printf '%s' "$DIALOG_STUB_TEXT"; return 0 ;;
    list-panes) return "${LIST_PANES_RC:-0}" ;;
  esac
  return 0
}

# D5: dialog present -> exactly one send-keys call, exactly "3", no Enter. A
# trailing Enter would land in the composer the dialog just uncovered.
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
: > "$TMUX_LOG3"
codex_dismiss_update_dialog_if_present "test:basalt"
sent5=$(grep -c 'send-keys' "$TMUX_LOG3" 2>/dev/null)
exact5=0
grep -qxF 'send-keys -t test:basalt 3' "$TMUX_LOG3" && exact5=1
if [ "$sent5" -eq 1 ] && [ "$exact5" -eq 1 ]; then
  pass "D5 dismissal: dialog present -> exactly 'send-keys -t <target> 3', no Enter"
else
  fail "D5 dismissal: dialog present -> exactly 'send-keys -t <target> 3', no Enter" \
    "sent=$sent5 exact=$exact5 log=$(cat "$TMUX_LOG3")"
fi

# D6: no dialog -> no keystroke at all. This runs on every codex launch, so the
# common case has to stay silent.
DIALOG_STUB_TEXT=""
: > "$TMUX_LOG3"
codex_dismiss_update_dialog_if_present "test:basalt"
sent6=$(grep -c 'send-keys' "$TMUX_LOG3" 2>/dev/null)
[ "$sent6" -eq 0 ] \
  && pass "D6 dismissal: no dialog present -> no keystroke" \
  || fail "D6 dismissal: no dialog present -> no keystroke" "sent=$sent6"

# ---- dialog handling wired through the verifier ----------------------------

# D7 (the scope decision): an EMPTY sid, i.e. a genuine first boot with nothing
# resumed, plus a dialog. The dismissal must STILL fire. This is the case that
# would silently regress if the dialog check were gated on a non-empty sid the
# way the crash check is, leaving every first-boot codex agent frozen.
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
: > "$TMUX_LOG3"
codex_verify_resume_or_fallback "test:basalt" basalt "" "$MODEL_FLAG"
rc7=$?
sent7=$(grep -c 'send-keys' "$TMUX_LOG3" 2>/dev/null)
dismiss7=0
grep -qxF 'send-keys -t test:basalt 3' "$TMUX_LOG3" && dismiss7=1
if [ "$rc7" -eq 0 ] && [ "$sent7" -eq 1 ] && [ "$dismiss7" -eq 1 ]; then
  pass "D7 first boot (empty sid) + dialog: the dismissal still fires"
else
  fail "D7 first boot (empty sid) + dialog: the dismissal still fires" \
    "rc=$rc7 sent=$sent7 dismiss=$dismiss7"
fi

# D8: dialog dismissed, and the pane then stays healthy for the WHOLE poll.
# The stub answers 'node' unconditionally, so it must be read at least 3 times
# (the consecutive-healthy threshold) before the pane is trusted. Asserting
# "one good read, no fallback" instead would pin the unsafe assumption rather
# than the safe one.
codex_pane_current_command() { printf 'node\n'; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
: > "$TMUX_LOG3"
codex_verify_resume_or_fallback "test:basalt" basalt "some-sid-1234" "$MODEL_FLAG"
rc8=$?
sent8=$(grep -c 'send-keys' "$TMUX_LOG3" 2>/dev/null)
dismiss8=0
grep -qxF 'send-keys -t test:basalt 3' "$TMUX_LOG3" && dismiss8=1
if [ "$rc8" -eq 0 ] && [ "$sent8" -eq 1 ] && [ "$dismiss8" -eq 1 ]; then
  pass "D8 resume + dialog, healthy through the full poll: no fallback"
else
  fail "D8 resume + dialog, healthy through the full poll: no fallback" \
    "rc=$rc8 sent=$sent8 dismiss=$dismiss8"
fi

# D9 (the regression the bounded poll closes): the dialog is dismissed, but the
# resume behind it was also going to fail, and the pane never comes up as
# codex/node at all. A single immediate check after dismissal would have
# returned healthy. Assert the fully-flagged fallback AND the quarantine, plus
# the stderr wording: a CONFIRMED crash must read differently from the
# inconclusive timeout D11 pins, because they are genuinely different
# situations and the boot log is where someone tells them apart.
D9_DIR=$(mktemp -d)
D9_SID="d9deadbe-ef00-4444-8888-000000000009"
: > "$D9_DIR/rollout-2026-01-04T10-00-00-${D9_SID}.jsonl"
codex_pane_current_command() { printf 'bash\n'; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D9_DIR"
: > "$TMUX_LOG3"
d9_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$D9_SID" "$MODEL_FLAG" 2>&1)
rc9=$?
resend9_ok=0
resend_logged "$TMUX_LOG3" && resend9_ok=1
renamed9_ok=0
[ -f "$D9_DIR/rollout-2026-01-04T10-00-00-${D9_SID}.jsonl.codex-resume-failed" ] && renamed9_ok=1
orig9_gone=0
[ ! -f "$D9_DIR/rollout-2026-01-04T10-00-00-${D9_SID}.jsonl" ] && orig9_gone=1
wording9_ok=0
printf '%s' "$d9_err" | grep -q 'not codex/node' \
  && ! printf '%s' "$d9_err" | grep -q 'could not be confirmed healthy' \
  && wording9_ok=1
if [ "$rc9" -ne 0 ] && [ "$resend9_ok" -eq 1 ] && [ "$renamed9_ok" -eq 1 ] && [ "$orig9_gone" -eq 1 ] && [ "$wording9_ok" -eq 1 ]; then
  pass "D9 post-dismissal crash: fresh codex re-sent, session quarantined, confirmed-crash wording"
else
  fail "D9 post-dismissal crash: fresh codex re-sent, session quarantined, confirmed-crash wording" \
    "rc=$rc9 resend_ok=$resend9_ok renamed_ok=$renamed9_ok orig_gone=$orig9_gone wording_ok=$wording9_ok err=$d9_err"
fi
rm -rf "$D9_DIR"

# D9b: the same confirmed crash, but the fallback send itself FAILS -- the tmux
# target vanished at the moment of the re-send, a worse problem than a bad
# session. The re-send is still ATTEMPTED (the gate is on its outcome, not on
# whether it is tried), but a fallback that never landed is not grounds to
# quarantine anything, so the session file must survive untouched even though
# the crash was confirmed.
D9B_DIR=$(mktemp -d)
D9B_SID="d9bdeadb-ef00-4444-8888-00000000000e"
D9B_FILE="$D9B_DIR/rollout-2026-01-04T10-00-00-${D9B_SID}.jsonl"
: > "$D9B_FILE"
codex_pane_current_command() { printf 'bash\n'; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D9B_DIR"
SEND_KEYS_RC=1
: > "$TMUX_LOG3"
d9b_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$D9B_SID" "$MODEL_FLAG" 2>&1)
rc9b=$?
unset SEND_KEYS_RC
attempted9b=0
resend_logged "$TMUX_LOG3" && attempted9b=1
intact9b=0
[ -f "$D9B_FILE" ] && intact9b=1
wording9b_ok=0
printf '%s' "$d9b_err" | grep -q 'fallback codex re-send into' \
  && printf '%s' "$d9b_err" | grep -q 'FAILED' \
  && wording9b_ok=1
if [ "$rc9b" -ne 0 ] && [ "$attempted9b" -eq 1 ] && [ "$intact9b" -eq 1 ] && [ "$wording9b_ok" -eq 1 ]; then
  pass "D9b confirmed crash, send fails: attempted, session left intact, distinct wording"
else
  fail "D9b confirmed crash, send fails: attempted, session left intact, distinct wording" \
    "rc=$rc9b attempted=$attempted9b intact=$intact9b wording_ok=$wording9b_ok err=$d9b_err"
fi
rm -rf "$D9B_DIR"

# D10 (why the poll needs MULTIPLE consecutive good reads): the pane reads
# 'node', 'node', then 'bash'. It looked healthy for two checks before the
# crash actually landed, which is exactly what a single check, or a poll that
# trusted the first good read, would already have waved through. Pins that the
# threshold of 3 is load-bearing, and that the crash is caught on the third
# check rather than after the whole window.
D10_DIR=$(mktemp -d)
D10_SID="d10eadbe-ef00-4444-8888-00000000000a"
: > "$D10_DIR/rollout-2026-01-04T10-00-00-${D10_SID}.jsonl"
# The call count lives in a FILE, not a variable: codex_pane_current_command is
# invoked inside a command substitution, so an increment to an ordinary
# variable dies with that subshell and the counter would read the same value
# forever.
D10_CALLFILE=$(mktemp)
printf '0\n' > "$D10_CALLFILE"
codex_pane_current_command() {
  local n; n=$(($(cat "$D10_CALLFILE") + 1))
  printf '%s\n' "$n" > "$D10_CALLFILE"
  case "$n" in
    1|2) printf 'node\n' ;;
    *) printf 'bash\n' ;;
  esac
}
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D10_DIR"
: > "$TMUX_LOG3"
codex_verify_resume_or_fallback "test:basalt" basalt "$D10_SID" "$MODEL_FLAG"
rc10=$?
d10_calls=$(cat "$D10_CALLFILE")
resend10_ok=0
resend_logged "$TMUX_LOG3" && resend10_ok=1
renamed10_ok=0
[ -f "$D10_DIR/rollout-2026-01-04T10-00-00-${D10_SID}.jsonl.codex-resume-failed" ] && renamed10_ok=1
if [ "$rc10" -ne 0 ] && [ "$resend10_ok" -eq 1 ] && [ "$renamed10_ok" -eq 1 ] && [ "$d10_calls" -eq 3 ]; then
  pass "D10 transient good-then-crash (node,node,bash): caught on the 3rd check, not trusted after 2"
else
  fail "D10 transient good-then-crash (node,node,bash): caught on the 3rd check, not trusted after 2" \
    "rc=$rc10 resend_ok=$resend10_ok renamed_ok=$renamed10_ok calls=$d10_calls"
fi
rm -rf "$D10_DIR"
rm -f "$D10_CALLFILE"

# D11 (inconclusive, target confirmed GONE): every process read came back
# empty, and list-panes then fails outright. Empty reads are evidence the pane
# could not be observed, never evidence the SESSION was bad -- quarantining on
# that basis would lose a healthy continuity record and silently drop the next
# boot onto an older conversation. So: no fallback send is even attempted into
# a target that does not exist, the session file is left completely alone, and
# the escalation is worded unlike a confirmed crash.
D11_DIR=$(mktemp -d)
D11_SID="d11eadbe-ef00-4444-8888-00000000000b"
D11_FILE="$D11_DIR/rollout-2026-01-04T10-00-00-${D11_SID}.jsonl"
: > "$D11_FILE"
codex_pane_current_command() { printf ''; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D11_DIR"
LIST_PANES_RC=1
: > "$TMUX_LOG3"
d11_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$D11_SID" "$MODEL_FLAG" 2>&1)
rc11=$?
unset LIST_PANES_RC
# NOT a bare send-keys absence check: the dismissal keystroke legitimately logs
# one here, since the dialog is dismissed before classification begins. What
# must be absent is specifically the fallback RE-SEND.
sent11=0
resend_logged "$TMUX_LOG3" && sent11=1
intact11=0
[ -f "$D11_FILE" ] && intact11=1
wording11_ok=0
printf '%s' "$d11_err" | grep -q 'could not be located at all' \
  && ! printf '%s' "$d11_err" | grep -q 'not codex/node' \
  && wording11_ok=1
if [ "$rc11" -ne 0 ] && [ "$sent11" -eq 0 ] && [ "$intact11" -eq 1 ] && [ "$wording11_ok" -eq 1 ]; then
  pass "D11 inconclusive + target gone: no fallback attempted, session untouched, distinct escalation"
else
  fail "D11 inconclusive + target gone: no fallback attempted, session untouched, distinct escalation" \
    "rc=$rc11 sent=$sent11 intact=$intact11 wording_ok=$wording11_ok err=$d11_err"
fi
rm -rf "$D11_DIR"

# D11b (inconclusive, target still EXISTS, send succeeds): the sibling case. A
# fallback attempt is worth making, since there is a real target to send to and
# a live agent beats a frozen one. But a successful send answers only "did tmux
# accept keys", never "was the session at fault", so the session file must be
# preserved anyway. This is the case where send-success as a sufficient
# condition for quarantine would fail: the gate needs BOTH a successful send
# and a positively observed crash, and this scenario has only the first.
D11B_DIR=$(mktemp -d)
D11B_SID="d11beadb-ef00-4444-8888-00000000000c"
: > "$D11B_DIR/rollout-2026-01-04T10-00-00-${D11B_SID}.jsonl"
codex_pane_current_command() { printf ''; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D11B_DIR"
: > "$TMUX_LOG3"
d11b_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$D11B_SID" "$MODEL_FLAG" 2>&1)
rc11b=$?
resend11b_ok=0
resend_logged "$TMUX_LOG3" && resend11b_ok=1
intact11b_ok=0
[ -f "$D11B_DIR/rollout-2026-01-04T10-00-00-${D11B_SID}.jsonl" ] && intact11b_ok=1
notrenamed11b_ok=0
[ ! -f "$D11B_DIR/rollout-2026-01-04T10-00-00-${D11B_SID}.jsonl.codex-resume-failed" ] && notrenamed11b_ok=1
if [ "$rc11b" -ne 0 ] && [ "$resend11b_ok" -eq 1 ] && [ "$intact11b_ok" -eq 1 ] && [ "$notrenamed11b_ok" -eq 1 ]; then
  pass "D11b inconclusive + target exists + send succeeds: fallback attempted, session PRESERVED"
else
  fail "D11b inconclusive + target exists + send succeeds: fallback attempted, session PRESERVED" \
    "rc=$rc11b resend_ok=$resend11b_ok intact_ok=$intact11b_ok notrenamed_ok=$notrenamed11b_ok err=$d11b_err"
fi
rm -rf "$D11B_DIR"

# D11c: same as D11b, but the fallback send itself fails. A send that never
# landed is still no evidence about the session, even though a real target was
# confirmed to exist, so again nothing is quarantined.
D11C_DIR=$(mktemp -d)
D11C_SID="d11ceadb-ef00-4444-8888-00000000000d"
D11C_FILE="$D11C_DIR/rollout-2026-01-04T10-00-00-${D11C_SID}.jsonl"
: > "$D11C_FILE"
codex_pane_current_command() { printf ''; }
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
CODEX_SESSIONS_DIR="$D11C_DIR"
SEND_KEYS_RC=1
: > "$TMUX_LOG3"
d11c_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$D11C_SID" "$MODEL_FLAG" 2>&1)
rc11c=$?
unset SEND_KEYS_RC
attempted11c=0
resend_logged "$TMUX_LOG3" && attempted11c=1
intact11c=0
[ -f "$D11C_FILE" ] && intact11c=1
wording11c_ok=0
printf '%s' "$d11c_err" | grep -q 'fallback codex re-send into' \
  && printf '%s' "$d11c_err" | grep -q 'FAILED' \
  && wording11c_ok=1
if [ "$rc11c" -ne 0 ] && [ "$attempted11c" -eq 1 ] && [ "$intact11c" -eq 1 ] && [ "$wording11c_ok" -eq 1 ]; then
  pass "D11c inconclusive + target exists but send fails: attempted, session left intact, distinct wording"
else
  fail "D11c inconclusive + target exists but send fails: attempted, session left intact, distinct wording" \
    "rc=$rc11c attempted=$attempted11c intact=$intact11c wording_ok=$wording11c_ok err=$d11c_err"
fi
rm -rf "$D11C_DIR"

# D12: an empty read RESETS the consecutive-healthy streak, rather than merely
# not counting toward either outcome. Sequence: node, EMPTY, node, node, node.
# If the empty read carried the earlier count forward, the pane would be
# declared healthy on call 4 instead of call 5, so the exact call count is the
# assertion.
D12_CALLFILE=$(mktemp)
printf '0\n' > "$D12_CALLFILE"
codex_pane_current_command() {
  local n; n=$(($(cat "$D12_CALLFILE") + 1))
  printf '%s\n' "$n" > "$D12_CALLFILE"
  case "$n" in
    1) printf 'node\n' ;;
    2) printf '\n' ;;
    *) printf 'node\n' ;;
  esac
}
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
: > "$TMUX_LOG3"
codex_verify_resume_or_fallback "test:basalt" basalt "d12-not-a-real-file-sid" "$MODEL_FLAG"
rc12=$?
d12_calls=$(cat "$D12_CALLFILE")
# Same caveat as D11: the dismissal keystroke legitimately logs a send-keys
# call here. What must be absent is the fallback re-send.
sent12=0
resend_logged "$TMUX_LOG3" && sent12=1
if [ "$rc12" -eq 0 ] && [ "$sent12" -eq 0 ] && [ "$d12_calls" -eq 5 ]; then
  pass "D12 empty read resets the healthy streak (healthy on call 5, not 4)"
else
  fail "D12 empty read resets the healthy streak (healthy on call 5, not 4)" \
    "rc=$rc12 sent=$sent12 calls=$d12_calls"
fi
rm -f "$D12_CALLFILE"

# T13 (the no-dialog path's own classification): no dialog is shown, so the
# single settled check runs rather than the poll, the one process read comes
# back EMPTY, and the target still exists. An empty read here is exactly as
# ambiguous as an empty read inside the poll, so it must classify as
# inconclusive. Treating it as a crash would quarantine a healthy session on
# zero evidence through a one-check window instead of the poll's ten -- the
# same bug, reached by a narrower door. A fallback is still attempted, because
# the target exists and recovery is worth trying, but the session survives.
T13_DIR=$(mktemp -d)
T13_SID="t13eadbe-ef00-4444-8888-00000000000d"
: > "$T13_DIR/rollout-2026-01-04T10-00-00-${T13_SID}.jsonl"
codex_pane_current_command() { printf ''; }
DIALOG_STUB_TEXT=""
CODEX_SESSIONS_DIR="$T13_DIR"
: > "$TMUX_LOG3"
t13_err=$(codex_verify_resume_or_fallback "test:basalt" basalt "$T13_SID" "$MODEL_FLAG" 2>&1)
rc13=$?
resend13_ok=0
resend_logged "$TMUX_LOG3" && resend13_ok=1
intact13_ok=0
[ -f "$T13_DIR/rollout-2026-01-04T10-00-00-${T13_SID}.jsonl" ] && intact13_ok=1
notrenamed13_ok=0
[ ! -f "$T13_DIR/rollout-2026-01-04T10-00-00-${T13_SID}.jsonl.codex-resume-failed" ] && notrenamed13_ok=1
if [ "$rc13" -ne 0 ] && [ "$resend13_ok" -eq 1 ] && [ "$intact13_ok" -eq 1 ] && [ "$notrenamed13_ok" -eq 1 ]; then
  pass "T13 no-dialog path, empty read, target exists: fallback attempted, session PRESERVED"
else
  fail "T13 no-dialog path, empty read, target exists: fallback attempted, session PRESERVED" \
    "rc=$rc13 resend_ok=$resend13_ok intact_ok=$intact13_ok notrenamed_ok=$notrenamed13_ok err=$t13_err"
fi
rm -rf "$T13_DIR"
unset CODEX_SESSIONS_DIR

rm -f "$TMUX_LOG3"

echo
echo "boot-agents: $PASS passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
