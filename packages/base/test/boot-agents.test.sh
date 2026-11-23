#!/usr/bin/env bash
# Tests for bin/boot-agents.sh -- specifically its codex resume-on-relaunch
# machinery: codex_latest_session_for_workspace (the session lookup),
# codex_pane_has_update_dialog / codex_dismiss_update_dialog_if_present (the
# update-dialog detector and its keystroke), and
# codex_verify_launch (launch verification and checkpoint preservation).
#
#   bash packages/base/test/boot-agents.test.sh
#     -> prints PASS/FAIL per case, exits non-zero on any fail.
#
# NO LIVE TMUX, NO LIVE CODEX, and no real sessions directory is ever read or
# written. Session fixtures live under a scratch CODEX_SESSIONS_DIR; the pane
# check and tmux itself are stubbed. boot-agents.sh is sourced with
# BOOT_AGENTS_LIB_ONLY=1, which stops it at the library boundary before any
# live tmux call. Full boot fixtures below run separate subprocesses with
# exported tmux and sleep stubs.
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
# codex_verify_launch's job, one layer up. This pins where the
# responsibility boundary sits.
T9_DIR=$(mktemp -d)
BADSID="deadbeef-dead-beef-dead-beefdeadbeef"
mkfix "$T9_DIR" 2026-01-03T10-00-00 "$BADSID" "$BADSID" "$BASALT_CWD" codex-tui user $((NOW - 50)) >/dev/null
printf 'TRUNCATED-CORRUPT-CONTENT-NOT-VALID-JSONL\n' >> "$T9_DIR/rollout-2026-01-03T10-00-00-${BADSID}.jsonl"
got=$(CODEX_SESSIONS_DIR="$T9_DIR" codex_latest_session_for_workspace basalt)
[ "$got" = "$BADSID" ] \
  && pass "T9 lookup still selects a session that is bad beyond line 1" \
  || fail "T9 lookup still selects a session that is bad beyond line 1" "got '$got'"

# ===== launch verification ==================================================
TMUX_LOG=$(mktemp)
tmux() {
  if [ "$1" = "send-keys" ]; then printf '%s\n' "$*" >> "$TMUX_LOG"; fi
  return 0
}
export CODEX_RESUME_VERIFY_SECS=0
export CODEX_RESUME_POLL_INTERVAL_SECS=0

# T10: the pane came up as a running Codex process.
codex_pane_current_command() { printf 'node\n'; }
if codex_verify_launch "test:basalt" basalt "$BADSID" && [ ! -s "$TMUX_LOG" ]; then
  pass "T10 healthy resume is confirmed"
else
  fail "T10 healthy resume is confirmed"
fi
rm -rf "$T9_DIR" "$TMUX_LOG"

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

# D3b (negative, LAST-LINE anchoring -- the false positive found by independent
# review, 2026-09): the same quoted anchors, but this time INSIDE the 20-line
# window, a few lines above a clean composer that is the real last line. D3 above
# only proves the window has an edge; this proves the window is not enough on its
# own, because a resumed session's most recent exchange is exactly the text most
# likely to be quoting this dialog and is exactly the text nearest the bottom.
# The footer has to be the last non-blank line, not merely present somewhere.
CODEX_DIALOG_QUOTED_ABOVE_COMPOSER=$'  ... earlier transcript\n\n\xe2\x80\xa2 Ran boot-agents on basalt\n\n  Codex printed "Update available! 0.149.1 -> 0.153.0", offered\n  "3. Skip until next version", and ended with "Press enter to continue".\n  I answered it, so the pane is clear now.\n\n\xe2\x80\xba Ask Codex to do anything'
if codex_pane_has_update_dialog "$CODEX_DIALOG_QUOTED_ABOVE_COMPOSER"; then
  fail "D3b detector: anchors quoted INSIDE the tail, composer is the last line -> no" \
    "matched a quote sitting above a ready composer"
else pass "D3b detector: anchors quoted INSIDE the tail, composer is the last line -> no"; fi

# D4: an ordinary idle pane, and an empty capture.
if codex_pane_has_update_dialog $'some transcript\n\n\xe2\x80\xba Ask Codex to do anything'; then
  fail "D4 detector: ordinary idle pane -> no"; else pass "D4 detector: ordinary idle pane -> no"; fi
if codex_pane_has_update_dialog ""; then
  fail "D4b detector: empty capture -> no"; else pass "D4b detector: empty capture -> no"; fi

# ---- the keystroke ---------------------------------------------------------
DIALOG_STUB_TEXT=""
TMUX_LOG3=$(mktemp)
tmux() {
  case "$1" in
    send-keys) printf '%s\n' "$*" >> "$TMUX_LOG3" ;;
    capture-pane) printf '%s' "$DIALOG_STUB_TEXT" ;;
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

# D6b: the D3b pane -- a quoted dialog above a ready composer -- gets NO
# keystroke. This is the assertion that matters, and the reason D3b exists: the
# predicate returning true is not itself the harm, sending "3" at a live composer
# is. The digit is not submitted, so it stages as text nobody typed, and staged
# text is what bin/inbox-push's composer-clean gate refuses to type over -- one
# false positive silently takes the agent off the delivery path. Asserted on the
# send-keys log rather than on the return code so that a future refactor which
# moves the decision out of the detector cannot pass this case while still
# sending the key.
DIALOG_STUB_TEXT="$CODEX_DIALOG_QUOTED_ABOVE_COMPOSER"
: > "$TMUX_LOG3"
codex_dismiss_update_dialog_if_present "test:basalt"
rc6b=$?
sent6b=$(grep -c 'send-keys' "$TMUX_LOG3" 2>/dev/null)
if [ "$sent6b" -eq 0 ] && [ "$rc6b" -ne 0 ]; then
  pass "D6b dismissal: quoted dialog above a ready composer -> no '3' into the composer"
else
  fail "D6b dismissal: quoted dialog above a ready composer -> no '3' into the composer" \
    "rc=$rc6b sent=$sent6b log=$(cat "$TMUX_LOG3")"
fi

# ---- dialog handling wired through the verifier ----------------------------

# D7 (the scope decision): an EMPTY sid, i.e. a genuine first boot with nothing
# resumed, plus a dialog. The dismissal must still fire.
DIALOG_STUB_TEXT="$CODEX_UPDATE_DIALOG"
: > "$TMUX_LOG3"
codex_verify_launch "test:basalt" basalt ""
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
codex_verify_launch "test:basalt" basalt "some-sid-1234"
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

# D10 (why the poll needs MULTIPLE consecutive good reads): the pane reads
# 'node', 'node', then 'bash'. It looked healthy for two checks before the
# crash actually landed, which is exactly what a single check, or a poll that
# trusted the first good read, would already have waved through. Pins that the
# threshold of 3 is load-bearing, and that the crash is caught on the third
# check rather than after the whole window.
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
: > "$TMUX_LOG3"
d10_err=$(codex_verify_launch "test:basalt" basalt "$BADSID" 2>&1)
rc10=$?
d10_calls=$(cat "$D10_CALLFILE")
if [ "$rc10" -eq 1 ] && [ "$d10_calls" -eq 3 ] \
  && [ "$(cat "$TMUX_LOG3")" = "send-keys -t test:basalt 3" ] \
  && [[ "$d10_err" == *"could not be confirmed"* ]]; then
  pass "D10 transient good-then-shell (node,node,bash): resume unconfirmed on the 3rd check"
else
  fail "D10 transient good-then-shell" "rc=$rc10 calls=$d10_calls stderr=$d10_err"
fi
rm -f "$D10_CALLFILE"

# D11: after a dialog dismissal, empty process reads exhaust the poll.
codex_pane_current_command() { return 1; }
: > "$TMUX_LOG3"
d11_err=$(codex_verify_launch "test:basalt" basalt "$BADSID" 2>&1)
rc11=$?
if [ "$rc11" -eq 1 ] && [ "$(cat "$TMUX_LOG3")" = "send-keys -t test:basalt 3" ] \
  && [[ "$d11_err" == *"pane command: unavailable"* ]]; then
  pass "D11 post-dialog process read unavailable: resume unconfirmed"
else
  fail "D11 post-dialog process read unavailable" "rc=$rc11 stderr=$d11_err"
fi

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
codex_verify_launch "test:basalt" basalt "d12-not-a-real-file-sid"
rc12=$?
d12_calls=$(cat "$D12_CALLFILE")
if [ "$rc12" -eq 0 ] && [ "$d12_calls" -eq 5 ] \
  && [ "$(cat "$TMUX_LOG3")" = "send-keys -t test:basalt 3" ]; then
  pass "D12 empty read resets the healthy streak (healthy on call 5)"
else
  fail "D12 empty read resets the healthy streak" "rc=$rc12 calls=$d12_calls"
fi
rm -f "$D12_CALLFILE"

# ===== provider-envelope construction ==================================

# P1: shared-home compatibility. CODEX_HOME must be omitted, not exported as
# an empty string, while secrets and agent identity/config remain present.
p1_cmd=$(codex_launch_command alex "copywriter" "" "" "")
p1_rc=$?
p1_ok=0
if [ "$p1_rc" -eq 0 ] \
  && printf '%s' "$p1_cmd" | grep -qF "[ -f $AGENTS_HOME/alex/.env.secrets ] && . $AGENTS_HOME/alex/.env.secrets;" \
  && printf '%s' "$p1_cmd" | grep -qF 'env AGENT_NAME=alex AGENT_ROLE=copywriter' \
  && ! printf '%s' "$p1_cmd" | grep -q 'CODEX_HOME=' \
  && printf '%s' "$p1_cmd" | grep -qE ' codex$'; then
  p1_ok=1
fi
if [ "$p1_ok" -eq 1 ]; then
  pass "P1 shared provider envelope: secrets + identity/config retained, CODEX_HOME omitted"
else
  fail "P1 shared provider envelope: secrets + identity/config retained, CODEX_HOME omitted" \
    "rc=$p1_rc cmd=$p1_cmd"
fi

# P2: an isolated home moves the session lookup with it. The explicit
# CODEX_SESSIONS_DIR seam still wins in lookup tests above; this pure helper
# defines the production default selected by launch_agent.
P2_HOME="/tmp/codex-provider-home-p2-$$"
p2_isolated=$(codex_sessions_dir_for_home "$P2_HOME")
p2_shared=$(codex_sessions_dir_for_home "")
if [ "$p2_isolated" = "$P2_HOME/sessions" ] \
  && [ "$p2_shared" = "$HOME/.codex/sessions" ]; then
  pass "P2 session directory follows isolated home and preserves shared default"
else
  fail "P2 session directory follows isolated home and preserves shared default" \
    "isolated=$p2_isolated shared=$p2_shared"
fi

# P3: a resume uses the same Azure provider envelope as a new session.
P3_HOME="$BOX/azure-codex-home"
P3_SID="p3azure0-ef00-4444-8888-00000000000f"
p3_resume=$(codex_launch_command iris "researcher" "$P3_HOME" "$P3_SID" "--model gpt-5.6-sol")
p3_fresh=$(codex_launch_command iris "researcher" "$P3_HOME" "" "--model gpt-5.6-sol")
if [ "$p3_resume" = "$p3_fresh resume $P3_SID" ] \
  && [[ "$p3_fresh" == *"[ -f $AGENTS_HOME/iris/.env.secrets ] && . $AGENTS_HOME/iris/.env.secrets;"* ]] \
  && [[ "$p3_fresh" == *"AGENT_NAME=iris AGENT_ROLE=researcher CODEX_HOME=$P3_HOME codex --model gpt-5.6-sol" ]]; then
  pass "P3 Azure resume carries the complete provider envelope"
else
  fail "P3 Azure resume carries the complete provider envelope" "$p3_resume"
fi
unset CODEX_SESSIONS_DIR

# ---------------------------------------------------------------------------
# Claude pinned session ids (claude-session.sh, sourced by boot-agents.sh).
# Issue #23: `--resume <name>` on a new agent opens a picker, so every claude
# agent is pinned by id in $AGENTS_HOME/<name>/.session-id instead. These cases
# never run claude; they point CLAUDE_CONFIG_DIR at a scratch tree and write
# transcript files where Claude Code would, then read claude_session_args.
# ---------------------------------------------------------------------------
export CLAUDE_CONFIG_DIR="$BOX/claude-config"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

if ! declare -F claude_session_args >/dev/null; then
  fail "claude-session.sh is sourced by boot-agents.sh"
else
  pass "claude-session.sh is sourced by boot-agents.sh"
fi

# C1: a brand new agent gets a fresh, named, pinned session, never a resume.
C_HOME="$AGENTS_HOME/wren"
rm -f "$C_HOME/.session-id"
c1_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"; c1_rc=$?
c1_pin="$(cat "$C_HOME/.session-id" 2>/dev/null)"
if [ "$c1_rc" -eq 0 ] \
  && [[ "$c1_pin" =~ $UUID_RE ]] \
  && [ "$c1_args" = "--session-id $c1_pin -n wren" ]; then
  pass "C1 new agent: --session-id <fresh id> -n <name>, id pinned"
else
  fail "C1 new agent: --session-id <fresh id> -n <name>, id pinned" "rc=$c1_rc args=$c1_args pin=$c1_pin"
fi

# C2: once the session has a transcript, the next boot resumes that same id.
C_PROJECT="$(claude_project_dir_for "$C_HOME")"
mkdir -p "$C_PROJECT"
c_convo() { printf '{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"%s"}\n' "$1"; }
printf '{"type":"custom-title","customTitle":"wren","sessionId":"%s"}\n' "$c1_pin" > "$C_PROJECT/$c1_pin.jsonl"
c_convo "$c1_pin" >> "$C_PROJECT/$c1_pin.jsonl"
c2_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"; c2_rc=$?
c2b_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"
c2_pin="$(cat "$C_HOME/.session-id" 2>/dev/null)"
if [ "$c2_rc" -eq 0 ] \
  && [ "$c2_args" = "--resume $c1_pin -n wren" ] \
  && [ "$c2b_args" = "$c2_args" ] \
  && [ "$c2_pin" = "$c1_pin" ]; then
  pass "C2 relaunch: --resume <pinned id> -n <name>, same id every time"
else
  fail "C2 relaunch: --resume <pinned id> -n <name>, same id every time" "rc=$c2_rc args=$c2_args again=$c2b_args pin=$c2_pin"
fi

# C3: the pinned transcript is gone. Start a fresh named session under a new
# pinned id; never a resume, which would exit "No conversation found".
rm -f "$C_PROJECT/$c1_pin.jsonl"
c3_args="$(claude_session_args wren "$C_HOME" 2>"$BOX/c3.err")"; c3_rc=$?
c3_pin="$(cat "$C_HOME/.session-id" 2>/dev/null)"
if [ "$c3_rc" -eq 0 ] \
  && [[ "$c3_pin" =~ $UUID_RE ]] \
  && [ "$c3_pin" != "$c1_pin" ] \
  && [ "$c3_args" = "--session-id $c3_pin -n wren" ] \
  && grep -q "has no conversation" "$BOX/c3.err"; then
  pass "C3 missing transcript: fresh named session, new id pinned, reason on stderr"
else
  fail "C3 missing transcript: fresh named session, new id pinned, reason on stderr" "rc=$c3_rc args=$c3_args pin=$c3_pin"
fi

# C3b: the transcript exists but holds no message. Claude Code leaves exactly
# this behind for a session opened and closed without anyone typing, and
# `--resume <id>` on it exits "No conversation found". Fresh session instead.
c3b_old="$c3_pin"
printf '{"type":"custom-title","customTitle":"wren","sessionId":"%s"}\n{"type":"mode","mode":"normal","sessionId":"%s"}\n' "$c3b_old" "$c3b_old" > "$C_PROJECT/$c3b_old.jsonl"
c3b_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"; c3b_rc=$?
c3b_pin="$(cat "$C_HOME/.session-id" 2>/dev/null)"
if [ "$c3b_rc" -eq 0 ] && [[ "$c3b_pin" =~ $UUID_RE ]] && [ "$c3b_pin" != "$c3b_old" ] \
  && [ "$c3b_args" = "--session-id $c3b_pin -n wren" ]; then
  pass "C3b metadata-only transcript: fresh named session, not a resume"
else
  fail "C3b metadata-only transcript: fresh named session, not a resume" "rc=$c3b_rc args=$c3b_args pin=$c3b_pin old=$c3b_old"
fi

# C4: a corrupt pin is treated like a missing transcript, not passed to claude.
printf 'not-a-uuid\n' > "$C_HOME/.session-id"
c4_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"; c4_rc=$?
c4_pin="$(cat "$C_HOME/.session-id" 2>/dev/null)"
if [ "$c4_rc" -eq 0 ] && [[ "$c4_pin" =~ $UUID_RE ]] \
  && [ "$c4_args" = "--session-id $c4_pin -n wren" ]; then
  pass "C4 corrupt pin: replaced with a fresh id"
else
  fail "C4 corrupt pin: replaced with a fresh id" "rc=$c4_rc args=$c4_args pin=$c4_pin"
fi

# C5: migration. An agent from before the pin has no .session-id but a session
# named by hand. The newest transcript whose LATEST title is the agent's name
# is pinned and resumed; one renamed away since, an older match, and a newer
# one with no messages in it, are not.
mkdir -p "$AGENTS_HOME/fern"; : > "$AGENTS_HOME/fern/SOUL.md"
F_HOME="$AGENTS_HOME/fern"
F_PROJECT="$(claude_project_dir_for "$F_HOME")"
mkdir -p "$F_PROJECT"
F_OLD=11111111-1111-4111-8111-111111111111
F_NEW=22222222-2222-4222-8222-222222222222
F_AWAY=33333333-3333-4333-8333-333333333333
printf '{"type":"custom-title","customTitle":"fern","sessionId":"%s"}\n' "$F_OLD" > "$F_PROJECT/$F_OLD.jsonl"
printf '{"type":"custom-title","customTitle":"fern","sessionId":"%s"}\n' "$F_NEW" > "$F_PROJECT/$F_NEW.jsonl"
printf '{"type":"custom-title","customTitle":"fern","sessionId":"%s"}\n{"type":"custom-title","customTitle":"other","sessionId":"%s"}\n' "$F_AWAY" "$F_AWAY" > "$F_PROJECT/$F_AWAY.jsonl"
for f_id in "$F_OLD" "$F_NEW" "$F_AWAY"; do c_convo "$f_id" >> "$F_PROJECT/$f_id.jsonl"; done
F_EMPTY=44444444-4444-4444-8444-444444444444
printf '{"type":"custom-title","customTitle":"fern","sessionId":"%s"}\n' "$F_EMPTY" > "$F_PROJECT/$F_EMPTY.jsonl"
touch -t 202601040000 "$F_PROJECT/$F_EMPTY.jsonl"
touch -t 202601010000 "$F_PROJECT/$F_OLD.jsonl"
touch -t 202601020000 "$F_PROJECT/$F_NEW.jsonl"
touch -t 202601030000 "$F_PROJECT/$F_AWAY.jsonl"
c5_args="$(claude_session_args fern "$F_HOME" 2>/dev/null)"; c5_rc=$?
c5_pin="$(cat "$F_HOME/.session-id" 2>/dev/null)"
if [ "$c5_rc" -eq 0 ] && [ "$c5_pin" = "$F_NEW" ] \
  && [ "$c5_args" = "--resume $F_NEW -n fern" ]; then
  pass "C5 migration: newest session still named after the agent is pinned and resumed"
else
  fail "C5 migration: newest session still named after the agent is pinned and resumed" "rc=$c5_rc args=$c5_args pin=$c5_pin"
fi

# C6: the transcript directory is derived from the PHYSICAL path, because that
# is what the claude process records as its working directory.
ln -s "$AGENTS_HOME" "$BOX/homes-link"
c6_via_link="$(claude_project_dir_for "$BOX/homes-link/wren")"
c6_direct="$(claude_project_dir_for "$(cd "$C_HOME" && pwd -P)")"
c6_expect="$CLAUDE_CONFIG_DIR/projects/$(cd "$C_HOME" && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"
if [ "$c6_via_link" = "$c6_direct" ] && [ "$c6_direct" = "$c6_expect" ]; then
  pass "C6 project dir: symlinks resolved, non-alphanumerics become '-'"
else
  fail "C6 project dir: symlinks resolved, non-alphanumerics become '-'" "link=$c6_via_link direct=$c6_direct expect=$c6_expect"
fi

# C7: neither launcher still resumes by name.
c7_bad=""
for f in boot-agents.sh workspace.sh; do
  grep -q 'claude --resume \$' "$(dirname "$BIN")/$f" && c7_bad="$c7_bad $f"
done
if [ -z "$c7_bad" ]; then
  pass "C7 launchers no longer run claude --resume <name>"
else
  fail "C7 launchers no longer run claude --resume <name>" "still in:$c7_bad"
fi

# C8: the day-one message rides a new, never-launched agent only, exactly once.
# Reuses C_HOME (wren); it has no IDENTITY.md, so day one has not happened.
rm -f "$C_HOME/.session-id" "$C_HOME/.first-boot-done"
c8_first="$(claude_session_args wren "$C_HOME" 2>/dev/null)"
c8_prompt="$(eval "printf '%s' $(claude_first_boot_prompt "$c8_first" "$C_HOME")")"
if [[ "$c8_prompt" == *"first session"* && "$c8_prompt" == *"day-one"* && -e "$C_HOME/.first-boot-done" ]]; then
  pass "C8 new agent: carries the day-one first message and leaves a marker"
else
  fail "C8 new agent: carries the day-one first message and leaves a marker" "prompt=$c8_prompt"
fi
# Same pin, still no conversation (killed before the message was recorded): the
# marker stops a repeat. This is the documented limit.
c8_again="$(claude_first_boot_prompt "$(claude_session_args wren "$C_HOME" 2>/dev/null)" "$C_HOME")"
[ -z "$c8_again" ] && pass "C8 marker: no repeat for the same agent" || fail "C8 marker: no repeat for the same agent" "prompt=$c8_again"
# A resume never gets it, marker or not.
c8_pin="$(cat "$C_HOME/.session-id")"
printf '{"type":"custom-title","customTitle":"wren","sessionId":"%s"}\n' "$c8_pin" > "$C_PROJECT/$c8_pin.jsonl"
c_convo "$c8_pin" >> "$C_PROJECT/$c8_pin.jsonl"
rm -f "$C_HOME/.first-boot-done"
c8_second="$(claude_session_args wren "$C_HOME" 2>/dev/null)"
if [ "$c8_second" = "--resume $c8_pin -n wren" ] && [ -z "$(claude_first_boot_prompt "$c8_second" "$C_HOME")" ]; then
  pass "C8 later launches: resume, no first message"
else
  fail "C8 later launches: resume, no first message" "second=$c8_second"
fi
# An established agent whose transcript was pruned takes the new-session branch
# but already wrote its persona, so it is not told it is new.
rm -f "$C_PROJECT/$c8_pin.jsonl" "$C_HOME/.first-boot-done"
printf '# Wren\nName: Wren\n' > "$C_HOME/IDENTITY.md"
c8_pruned="$(claude_session_args wren "$C_HOME" 2>/dev/null)"
if [[ "$c8_pruned" == "--session-id "* ]] && [ -z "$(claude_first_boot_prompt "$c8_pruned" "$C_HOME")" ] && [ ! -e "$C_HOME/.first-boot-done" ]; then
  pass "C8 pruned transcript, persona already written: no first message"
else
  fail "C8 pruned transcript, persona already written: no first message" "args=$c8_pruned"
fi
rm -f "$C_HOME/IDENTITY.md"

# C8b: only an assistant's first message carries the first-conversation sentence.
rm -f "$C_HOME/.session-id" "$C_HOME/.first-boot-done" "$C_HOME/.kind"
c8b_plain="$(eval "printf '%s' $(claude_first_boot_prompt "$(claude_session_args wren "$C_HOME" 2>/dev/null)" "$C_HOME")")"
rm -f "$C_HOME/.session-id" "$C_HOME/.first-boot-done"
printf 'assistant' > "$C_HOME/.kind"
c8b_args="$(claude_session_args wren "$C_HOME" 2>/dev/null)"
c8b_prompt="$(eval "printf '%s' $(claude_first_boot_prompt "$c8b_args" "$C_HOME")")"
c8b_again="$(claude_first_boot_prompt "$c8b_args" "$C_HOME")"
if [[ "$c8b_prompt" == *"first conversation"* && "$c8b_plain" != *"first conversation"* && "$c8b_plain" == *"day-one"* && -z "$c8b_again" ]]; then
  pass "C8b first message: first-conversation sentence for an assistant only, still once"
else
  fail "C8b first message: first-conversation sentence for an assistant only, still once" "plain=$c8b_plain assistant=$c8b_prompt again=$c8b_again"
fi
rm -f "$C_HOME/.kind" "$C_HOME/.session-id" "$C_HOME/.first-boot-done"

# C9: .model is validated before it reaches a shell command line.
printf 'claude-sonnet-5-5\n' > "$C_HOME/.model"
[ "$(agent_model_flag "$C_HOME")" = "--model claude-sonnet-5-5" ] && pass "C9 .model: plain id becomes --model" || fail "C9 .model: plain id becomes --model"
printf 'x; touch /tmp/pwned' > "$C_HOME/.model"
c9_out="$(agent_model_flag "$C_HOME" 2>/dev/null)"
[ -z "$c9_out" ] && pass "C9 .model: unsafe value is refused" || fail "C9 .model: unsafe value is refused" "out=$c9_out"
printf '  claude-sonnet-5-5  \n' > "$C_HOME/.model"
[ "$(agent_model_flag "$C_HOME")" = "--model claude-sonnet-5-5" ] && pass "C9 .model: surrounding whitespace is trimmed" || fail "C9 .model: surrounding whitespace is trimmed"
printf 'claude sonnet\n' > "$C_HOME/.model"
c9_ws="$(agent_model_flag "$C_HOME" 2>/dev/null)"
[ -z "$c9_ws" ] && pass "C9 .model: interior space is refused, not squeezed" || fail "C9 .model: interior space is refused, not squeezed" "out=$c9_ws"
rm -f "$C_HOME/.model"
unset CLAUDE_CONFIG_DIR

# Full boot fixtures use exported shell functions, so no call reaches tmux.
# Each subprocess owns its scratch homes, logs and runtime state.
BOOT_BOX="$BOX/boot"
mkdir -p "$BOOT_BOX/homes/demo" "$BOOT_BOX/sessions"
: > "$BOOT_BOX/homes/demo/SOUL.md"
BOOT_SCRIPT="$BIN"
export BOOT_BOX BOOT_SCRIPT
boot_fixture() {
  local scenario="$1" expected="$2" label="$3"
  local output rc
  rm -f "$BOOT_BOX/launched" "$BOOT_BOX/armed" "$BOOT_BOX/captures" "$BOOT_BOX/sessions/"*
  rm -rf "$BOOT_BOX/homes/demo/.codex-home"
  : > "$BOOT_BOX/log"
  : > "$BOOT_BOX/homes/demo/.auto-arm-watcher"
  printf 'claude\n' > "$BOOT_BOX/homes/demo/.runtime"
  [[ "$scenario" == opt-out ]] && rm -f "$BOOT_BOX/homes/demo/.auto-arm-watcher"
  local checkpoint="$BOOT_BOX/homes/demo/.codex-home/sessions/rollout-fixture-boot-test-id.jsonl"
  case "$scenario" in
    codex|resume-*|existing-codex) printf 'codex\n' > "$BOOT_BOX/homes/demo/.runtime" ;;
  esac
  if [[ "$scenario" == resume-* ]]; then
    mkdir -p "${checkpoint%/*}"
    : > "$BOOT_BOX/homes/demo/.codex-home/config.toml"
    printf '{"originator":"codex-tui","thread_source":"user","cwd":"%s","id":"boot-test-id"}\n' "$BOOT_BOX/homes/demo" > "$checkpoint"
    cp "$checkpoint" "$BOOT_BOX/expected-checkpoint"
  fi
  [[ "$scenario" == first-boot-again ]] || rm -f "$BOOT_BOX/homes/demo/.model"
  [[ "$scenario" == first-boot-busy ]] && printf 'claude-sonnet-5-5' > "$BOOT_BOX/homes/demo/.model"
  export BOOT_SCENARIO="$scenario"
  # Every scenario but first-boot* is an agent that already has a conversation,
  # so it resumes and no first message is sent. See claude-session.sh.
  export CLAUDE_CONFIG_DIR="$BOOT_BOX/claude"
  local boot_proj="$CLAUDE_CONFIG_DIR/projects/$(cd "$BOOT_BOX/homes/demo" && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"
  if [[ "$scenario" == first-boot-again ]]; then
    # Second boot of the same agent: the first boot left its pin and marker, and
    # by now the transcript holds the first message.
    local again_id; again_id="$(cat "$BOOT_BOX/homes/demo/.session-id")"
    mkdir -p "$boot_proj"
    c_convo "$again_id" > "$boot_proj/$again_id.jsonl"
  else
    rm -rf "$CLAUDE_CONFIG_DIR" "$BOOT_BOX/homes/demo/.session-id" "$BOOT_BOX/homes/demo/.first-boot-done"
  fi
  if [[ "$scenario" != first-boot* ]]; then
    mkdir -p "$boot_proj"
    printf '%s\n' 55555555-5555-4555-8555-555555555555 > "$BOOT_BOX/homes/demo/.session-id"
    c_convo 55555555-5555-4555-8555-555555555555 > "$boot_proj/55555555-5555-4555-8555-555555555555.jsonl"
  fi
  output=$(bash -c '
    tmux() {
      printf "%s\n" "$*" >> "$BOOT_BOX/log"
      while [[ "${1:-}" == "-S" ]]; do shift 2; done
      case "$1" in
        start-server|set) return 0 ;;
        has-session) [[ "$BOOT_SCENARIO" != session-fail ]] ;;
        new-session) [[ "$BOOT_SCENARIO" != session-fail ]] ;;
        list-windows) [[ "$BOOT_SCENARIO" != window-fail ]] && echo demo ;;
        new-window) return 1 ;;
        list-panes)
          if [[ "$BOOT_SCENARIO" == existing* || -f "$BOOT_BOX/launched" ]]; then
            case "$BOOT_SCENARIO" in
              resume-no-outcome) return 1 ;;
              missing-runtime|resume-*) echo bash ;;
              *) echo node ;;
            esac
          else echo bash; fi ;;
        send-keys)
          [[ "$BOOT_SCENARIO" == send-fail ]] && return 1
          if [[ "$*" == *"arm your monitor"* ]]; then
            [[ "$BOOT_SCENARIO" == monitor-send-fail ]] && return 1
            touch "$BOOT_BOX/armed"
          else touch "$BOOT_BOX/launched"; fi ;;
        capture-pane)
          local captures=0
          [[ -f "$BOOT_BOX/captures" ]] && captures=$(cat "$BOOT_BOX/captures")
          captures=$((captures + 1))
          echo "$captures" > "$BOOT_BOX/captures"
          if [[ "$BOOT_SCENARIO" == delayed && "$captures" -le 12 ]]; then
            echo "Loading session"
            return 0
          fi
          case "$BOOT_SCENARIO" in
            resume-wrapped-refusal) printf "base-runner-exec:\nREFUSED_LOCK_BUSY runner lock bus\ny or unrecoverable\n" ;;
            resume-silent-refusal|resume-no-outcome) : ;;
            existing-codex) printf "Earlier conversation\n› \n" ;;
            existing-busy) printf "────────\nThinking (esc to interrupt)\n❯ \n" ;;
            busy-history) printf "We discussed fullscreen and resume a conversation earlier\n────────\nThinking (esc to interrupt)\n❯ \n" ;;
            scroll-monitor)
              if [[ ! -f "$BOOT_BOX/armed" || "$*" == *"-S -2000"* ]]; then echo "Monitor started old"; fi
              [[ -f "$BOOT_BOX/armed" ]] && echo "Monitor started new"
              printf "────────\n❯ \n" ;;
            nbsp)
              [[ -f "$BOOT_BOX/armed" ]] && echo "Monitor started"
              printf "────────\n❯ \302\240\n" ;;
            existing-resume) printf "Resume a conversation\n❯ demo\n" ;;
            existing-fullscreen) printf "Try the fullscreen renderer?\n❯ Yes\n" ;;
            existing-approval) printf "Would you like to run the following command?\n\n  $ ls\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n" ;;
            trust|existing) printf "Do you trust the files in this folder?\n  1. Yes\n❯ 2. No (default)\nEnter to confirm\n" ;;
            apikey) printf "Detected a custom API key in your environment\n\n Do you want to use this API key?\n\n❯ 1. Yes\n  2. No (recommended)\n" ;;
            resume) printf "Resume a conversation\n❯ demo\n" ;;
            fullscreen) printf "Try the fullscreen renderer?\n❯ Yes\n" ;;
            unknown) printf "An unfamiliar first-run prompt\n❯ Proceed\n" ;;
            busy|first-boot-busy) printf "────────\nThinking (esc to interrupt)\n❯ \n" ;;
            staged) printf "────────\n❯ draft\n" ;;
            codex)
              [[ -f "$BOOT_BOX/armed" ]] && echo "Monitor started"
              printf "OpenAI Codex\n› \n" ;;
            *)
              [[ "$BOOT_SCENARIO" == history ]] && echo "Discussed folder trust, resume picker and fullscreen yesterday"
              [[ "$BOOT_SCENARIO" == old-monitor ]] && echo "Monitor started"
              [[ -f "$BOOT_BOX/armed" && "$BOOT_SCENARIO" == monitor-prose ]] && echo "I might use Monitor() later to watch inbox events"
              [[ -f "$BOOT_BOX/armed" && "$BOOT_SCENARIO" != monitor-prose && "$BOOT_SCENARIO" != monitor-timeout && "$BOOT_SCENARIO" != old-monitor ]] && echo "Monitor started"
              printf "────────\n❯ \n" ;;
          esac ;;
        *) return 1 ;;
      esac
    }
    sleep() { :; }
    # Emulate BSD sed treating backslash-x as x, rather than a hex escape.
    sed() {
      local arg
      local -a args=()
      for arg in "$@"; do
        [[ "$BOOT_SCENARIO" == nbsp ]] && arg="${arg//\\x/x}"
        args+=("$arg")
      done
      command sed "${args[@]}"
    }
    export -f tmux sleep sed
    unset CODEX_HOME
    export BOOT_READY_SECS=2
    [[ "$BOOT_SCENARIO" == delayed ]] && unset BOOT_READY_SECS
    AGENTS_HOME="$BOOT_BOX/homes" BOOT_STAGGER_SECS=0 CODEX_RESUME_VERIFY_SECS=0 bash "$BOOT_SCRIPT" demo
  ' 2>&1)
  rc=$?
  if [[ "$rc" -eq "$expected" ]] && printf '%s' "$output" | grep -qF "$label" && ! printf '%s' "$output" | grep -qF 'launched + armed'; then
    pass "full boot: $scenario ($rc, $label)"
  else
    fail "full boot: $scenario" "rc=$rc expected=$expected output=$output"
  fi
  if [[ "$scenario" == resume-* ]]; then
    if cmp -s "$checkpoint" "$BOOT_BOX/expected-checkpoint" \
      && [[ ! -e "$checkpoint.codex-resume-failed" ]] \
      && [[ "$(grep -c 'send-keys' "$BOOT_BOX/log")" -eq 1 ]] \
      && grep -q 'send-keys .* codex resume boot-test-id Enter$' "$BOOT_BOX/log"; then
      pass "full boot: $scenario preserves the selected checkpoint and sends Resume once"
    else
      fail "full boot: $scenario preserves the selected checkpoint and sends Resume once"
    fi
  fi
  case "$scenario" in
    trust|apikey|existing*|resume|fullscreen|unknown|busy|staged|missing-runtime|window-fail|send-fail)
      if grep -q 'arm your monitor' "$BOOT_BOX/log"; then fail "full boot: $scenario never arms"; else pass "full boot: $scenario never arms"; fi ;;
  esac
  if [[ "$scenario" == monitor-timeout || "$scenario" == scroll-monitor ]]; then
    local sends
    sends=$(grep -c 'arm your monitor' "$BOOT_BOX/log")
    [[ "$sends" -eq 1 ]] && pass "full boot: $scenario sends once" || fail "full boot: $scenario sends once" "sends=$sends"
  fi
  if [[ "$scenario" == first-boot-busy ]]; then
    # Exactly once: this first launch carries the first message. The
    # first-boot-again case after it is the second boot.
    local firsts
    firsts=$(grep -c 'This\\ is\\ your\\ first\\ session' "$BOOT_BOX/log")
    [[ "$firsts" -eq 1 ]] && pass "first boot sends the day-one message once" || fail "first boot sends the day-one message once" "sends=$firsts"
    # #36: focus-events is on before the first pane starts, and the per-agent
    # .model file reaches the launch command.
    [[ "$(grep -n 'focus-events on' "$BOOT_BOX/log" | head -1 | cut -d: -f1)" -lt "$(grep -n 'send-keys' "$BOOT_BOX/log" | head -1 | cut -d: -f1)" ]] \
      && pass "focus-events is set before the first pane launches" || fail "focus-events is set before the first pane launches"
    grep -q -- '--model claude-sonnet-5-5' "$BOOT_BOX/log" \
      && pass "the agent's .model file reaches the launch command" || fail "the agent's .model file reaches the launch command"
    grep -q -- '--session-id' "$BOOT_BOX/log" && pass "first boot starts a pinned new session" || fail "first boot starts a pinned new session"
    # An opted-in agent is not told to arm its monitor mid first turn.
    grep -q 'arm your monitor' "$BOOT_BOX/log" && fail "first boot never types the arm prompt" || pass "first boot never types the arm prompt"
  fi
  if [[ "$scenario" == first-boot-again ]]; then
    grep -q 'This\\ is\\ your\\ first\\ session' "$BOOT_BOX/log" && fail "second boot sends no first message" || pass "second boot sends no first message"
    grep -q -- '--resume' "$BOOT_BOX/log" && pass "second boot resumes the session" || fail "second boot resumes the session"
    grep -q 'arm your monitor' "$BOOT_BOX/log" && pass "second boot arms the opted-in monitor" || fail "second boot arms the opted-in monitor"
  fi
  if [[ "$scenario" == busy-history ]]; then
    [[ $(cat "$BOOT_BOX/captures") -ge 4 ]] && pass "busy history uses readiness budget" || fail "busy history uses readiness budget"
  fi
  if [[ "$scenario" == trust ]] && ! printf '%s' "$output" | grep -q 'No is preselected'; then fail "folder trust names the default and manual action"; fi
}
boot_fixture first-boot-busy 0 '1 launched and ready, 0 monitors armed'
boot_fixture first-boot-again 0 '1 launched and ready, 1 monitors armed'
boot_fixture delayed 0 '1 launched and ready, 1 monitors armed'
boot_fixture existing-resume 3 'demo waiting: resume picker'
boot_fixture existing-fullscreen 3 'demo waiting: fullscreen offer'
boot_fixture existing-approval 3 'demo waiting: approval prompt'
boot_fixture existing-busy 0 '1 already up and ready'
boot_fixture existing-codex 0 '1 already up and ready'
boot_fixture busy-history 3 'demo waiting: runtime busy'
boot_fixture scroll-monitor 0 '1 monitors armed'
boot_fixture nbsp 0 '1 launched and ready, 1 monitors armed'
boot_fixture trust 3 'demo waiting: folder trust'
boot_fixture existing 3 'demo waiting: folder trust'
boot_fixture resume 3 'demo waiting: resume picker'
boot_fixture fullscreen 3 'demo waiting: fullscreen offer'
boot_fixture unknown 3 'demo waiting: unrecognised screen'
boot_fixture busy 3 'demo waiting: runtime busy'
boot_fixture staged 3 'demo waiting: composer contains text or menu selection'
boot_fixture missing-runtime 3 'demo waiting: runtime not running'
boot_fixture trust 3 'waiting-detail: prompts=1 other=0'
boot_fixture apikey 3 'demo waiting: API key approval'
boot_fixture apikey 3 'waiting-detail: prompts=1 other=0'
boot_fixture missing-runtime 3 'waiting-detail: prompts=0 other=1'
boot_fixture session-fail 1 'session creation failed'
boot_fixture window-fail 1 'demo launch failed'
boot_fixture send-fail 1 'demo launch failed'
boot_fixture opt-out 0 '1 launched and ready, 0 monitors armed'
boot_fixture history 0 '1 launched and ready, 1 monitors armed'
boot_fixture old-monitor 3 'demo monitor unconfirmed'
boot_fixture ready 0 '1 launched and ready, 1 monitors armed'
boot_fixture existing-ready 0 '0 launched and ready, 0 monitors armed, 1 already up and ready'
boot_fixture resume-wrapped-refusal 1 "Codex Resume boot-test-id could not be confirmed (pane command: bash); checkpoint preserved"
boot_fixture resume-silent-refusal 1 "Codex Resume boot-test-id could not be confirmed (pane command: bash); checkpoint preserved"
boot_fixture resume-no-outcome 1 "Codex Resume boot-test-id could not be confirmed (pane command: unavailable); checkpoint preserved"
boot_fixture codex 0 '1 launched and ready, 1 monitors armed'
boot_fixture monitor-prose 3 'demo monitor unconfirmed'
boot_fixture monitor-timeout 3 'demo monitor unconfirmed'
boot_fixture monitor-send-fail 3 'demo monitor unconfirmed'

echo
echo "boot-agents: $PASS passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
