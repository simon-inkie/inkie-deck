#!/usr/bin/env bash
# Tests for bin/pane-idle -- the shared busy/idle classifier, the two
# composer-identification primitives that joined it at lib v2, and the Codex
# approval-dialog detector that joined it at lib v3.
#
#   bash packages/base/test/pane-idle.test.sh
#     -> prints PASS/FAIL per case, exits non-zero on any fail.
#
# WHY A SEPARATE SUITE when inbox-push.test.sh already drives all of this
# end-to-end: that suite grades the DECISIONS built on top of these functions
# (push / queue / skip). These are the unit-level assertions that belong with
# the code itself, and they are the ones a future edit to the lib would break
# first -- a lib change that happened not to move any inbox-push verdict would
# otherwise land unnoticed.
#
# Fixtures are real captured pane shapes with the identifying text replaced.
# Their SHAPE is the thing under test, so the glyphs, the spacing and the ANSI
# runs are verbatim.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$HERE/../bin" && pwd)"
LIB="$BIN/pane-idle"

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }

# ---- fixtures --------------------------------------------------------------------
# The three shapes that motivated the live-elapsed-counter rule. All are
# genuinely mid-turn, and none of them carries an enumerated literal.
BUSY_MODERN=$'· BUG-609 (High): "info not saving" churn bug - audit… (59s · thought for 2s)\n❯ '
BUSY_UNKNOWN_GLYPH=$'✽ Dilly-dallying… (16s)\n❯ '
BUSY_BARE_MINUTES=$'· Auditing the ledger… (1m 26s)\n❯ '
# Controls: markers the classifier has always known about.
BUSY_CLASSIC=$'⏵ Thinking… (esc to interrupt)\n❯ '
BUSY_COMPACTING=$'Compacting conversation…\n❯ '
BUSY_SPINNER=$'· Thinking...\n❯ '
BUSY_GEMINI=$'⠋ Generating\n❯ '
# Controls: genuinely idle. A completion marker carries a duration and MUST NOT
# read as busy, or every finished agent looks mid-turn forever.
IDLE_BREWED=$'  ⎿  Brewed for 39s\n  Done.\n❯ '
IDLE_WORKED=$'  ⎿  Worked for 2m 24s\n❯ '
IDLE_PROSE_DURATION=$'  I hit it live: my pane showed (1m 26s) mid-compact\n❯ '
IDLE_BARE=$'❯ '

# ---- 1. the busy/idle table ------------------------------------------------------
# shellcheck source=../bin/pane-idle
. "$LIB"
if [ -z "${PANE_IDLE_LIB_VERSION:-}" ]; then
  echo "FAIL  library did not load from $LIB"
  echo "pane-idle: 0 passed, 1 failed"
  exit 1
fi
pass "library sources cleanly and publishes PANE_IDLE_LIB_VERSION"

expect_busy() { if check_idle "$2"; then pass "busy: $1"; else fail "busy: $1" "read as idle"; fi; }
expect_idle() { if check_idle "$2"; then fail "idle: $1" "read as busy"; else pass "idle: $1"; fi; }

expect_busy "live counter with middot (59s . thought for 2s)" "$BUSY_MODERN"
expect_busy "live counter, unenumerated spinner glyph (16s)"  "$BUSY_UNKNOWN_GLYPH"
expect_busy "live counter, minutes, no middot (1m 26s)"       "$BUSY_BARE_MINUTES"
expect_busy "esc to interrupt"                                "$BUSY_CLASSIC"
expect_busy "Compacting conversation"                         "$BUSY_COMPACTING"
expect_busy "ASCII spinner"                                   "$BUSY_SPINNER"
expect_busy "Gemini Generating"                               "$BUSY_GEMINI"
expect_idle "completion marker Brewed for 39s"                "$IDLE_BREWED"
expect_idle "completion marker Worked for 2m 24s"             "$IDLE_WORKED"
expect_idle "prose that merely mentions a duration"           "$IDLE_PROSE_DURATION"
expect_idle "bare composer"                                   "$IDLE_BARE"

# ---- 2. pane_ctx_pct -------------------------------------------------------------
# Anchored on the ctx BAR, never the model name: an earlier copy keyed on one
# model's name and went blind to every agent running a different one.
CTX_BAR=$'output\n  alice │ Sonnet 5 │ ~/agents/alice │ ████░░░░░░ 46%'
CTX_INLINE=$'output\n  ~/agents/alice  Sonnet 5  ctx:42%'
GOT=$(pane_ctx_pct "$CTX_BAR" || true)
[ "$GOT" = "46" ] && pass "pane_ctx_pct: reads the bar format" \
  || fail "pane_ctx_pct: reads the bar format" "got '$GOT'"
GOT=$(pane_ctx_pct "$CTX_INLINE" || true)
[ "$GOT" = "42" ] && pass "pane_ctx_pct: reads the ctx:NN% format" \
  || fail "pane_ctx_pct: reads the ctx:NN% format" "got '$GOT'"
if pane_ctx_pct "$IDLE_BARE" >/dev/null 2>&1; then
  fail "pane_ctx_pct: returns non-zero when there is no reading"
else
  pass "pane_ctx_pct: returns non-zero when there is no reading"
fi

# ---- 3. CLI mode -----------------------------------------------------------------
printf '%s\n' "$BUSY_MODERN" | "$LIB" >/dev/null 2>&1
[ $? -eq 0 ] && pass "CLI: exit 0 on a busy pane" || fail "CLI: exit 0 on a busy pane"
printf '%s\n' "$IDLE_BREWED" | "$LIB" >/dev/null 2>&1
[ $? -eq 1 ] && pass "CLI: exit 1 on an idle pane" || fail "CLI: exit 1 on an idle pane"
V=$(printf '%s\n' "$BUSY_MODERN" | "$LIB" --verbose)
[ "$V" = "busy" ] && pass "CLI: --verbose prints the verdict" || fail "CLI: --verbose prints the verdict" "got '$V'"

# ---- 4. the composer primitives (lib v2) -----------------------------------------
[ "${PANE_IDLE_LIB_VERSION:-0}" -ge 2 ] \
  && pass "lib publishes version >= 2 (the composer primitives are present)" \
  || fail "lib publishes version >= 2" "got '${PANE_IDLE_LIB_VERSION:-none}'"

for fn in find_composer_line raw_line_for; do
  if declare -F "$fn" >/dev/null 2>&1; then pass "lib defines $fn"; else fail "lib defines $fn"; fi
done

# Claude Code: the background-task list renders BELOW the composer and its
# selected entry carries the SAME glyph. The composer is the prompt line under
# the RULE, never the last prompt line in the pane.
CC_BG_TASKS=$'  … +3 in progress, 19 pending, 42 completed\n──────────────── alice ──\n❯ actually half-typed by a person\n────────────────────\n  alice │ Sonnet 5 │ ~/agents/alice │ 29%\n\n  ● main\n❯ ◯ general-purpose  MR opener   32m 4s'
GOT=$(find_composer_line "$CC_BG_TASKS")
[ "$GOT" = $'❯ actually half-typed by a person' ] \
  && pass "find_composer_line: rule-anchored, not the task entry below it" \
  || fail "find_composer_line: rule-anchored, not the task entry below it" "got '$GOT'"

# Codex renders no rules around its composer, so the anchor cannot fire and the
# whole-pane tail -1 fallback is what keeps those panes working. The rotating
# hint is what an IDLE Codex composer shows.
CODEX_HINT=$'• Acknowledged. All closed from my side.\n\n› Use /skills to list available skills\n\n  gpt-5.6 default · ~/agents/alice'
GOT=$(find_composer_line "$CODEX_HINT")
[ "$GOT" = $'› Use /skills to list available skills' ] \
  && pass "find_composer_line: falls back to tail -1 on a rule-less (Codex) pane" \
  || fail "find_composer_line: falls back to tail -1 on a rule-less (Codex) pane" "got '$GOT'"

GOT=$(find_composer_line $'just some transcript\nno prompt glyph anywhere')
[ -z "$GOT" ] && pass "find_composer_line: prints nothing when there is no prompt line" \
  || fail "find_composer_line: prints nothing when there is no prompt line" "got '$GOT'"

# raw_line_for matches the ALREADY-identified plain line by content, so it can
# never pick a different line the way a glyph search can.
CODEX_HINT_RAW=$'• Acknowledged. All closed from my side.\n\n\033[0;1m›\033[0m \033[2mUse /skills to list available skills\033[0m\n\n  gpt-5.6 default · ~/agents/alice'
GOT=$(raw_line_for "$CODEX_HINT_RAW" $'› Use /skills to list available skills')
case "$GOT" in
  *$'\033[2m'*) pass "raw_line_for: returns the ANSI-preserved counterpart of the composer line" ;;
  *) fail "raw_line_for: returns the ANSI-preserved counterpart of the composer line" "got '$GOT'" ;;
esac
GOT=$(raw_line_for "$CODEX_HINT_RAW" $'› a line that is not in this capture')
[ -z "$GOT" ] && pass "raw_line_for: prints nothing when no raw line corresponds" \
  || fail "raw_line_for: prints nothing when no raw line corresponds" "got '$GOT'"

# ---- 5. structural: there is exactly ONE copy of each primitive ------------------
# The point of the lift is that there is one copy. A re-introduced local
# definition would shadow the lib SILENTLY, because bash takes the last
# definition and that is the local one.
for fn in find_composer_line raw_line_for check_idle; do
  if grep -qE "^$fn\(\)" "$BIN/inbox-push"; then
    fail "inbox-push no longer defines its own $fn" "local definition still present"
  else
    pass "inbox-push no longer defines its own $fn"
  fi
done
# ...and it pins the MINIMUM version, not merely "the lib loaded": against an
# older lib the functions it calls are undefined, which check_composer_clean
# reads as "unknown format" (the v2 primitives) or which answers "no dialog
# here" (the v3 detector). Silent in both cases, and dangerous in the second.
#
# RAISED to 3 alongside inbox-push's own assertion, and this grep is why the
# bump cannot be half-done in either direction: a caller still pinning 2 would
# keep running happily against a library that no longer carries what it calls,
# which is exactly the silence the version scheme exists to break.
if grep -q 'PANE_IDLE_LIB_VERSION" -ge 3' "$BIN/inbox-push"; then
  pass "inbox-push asserts a MINIMUM lib version (>=3), not just presence"
else
  fail "inbox-push asserts a MINIMUM lib version (>=3), not just presence"
fi

# ---- 6. the codex approval-dialog detector (lib v3) ------------------------------
# check_idle answers IDLE for a pane wedged on an unanswered Codex approval
# dialog: nothing is running, and the "esc to cancel" marker is anchored to
# lead-of-clause so the dialog footer no longer trips it. That verdict is
# correct and useless to a caller about to press a key, because IDLE is exactly
# what licenses typing into a pane -- and Enter is the dialog's CONFIRM key. The
# busy/idle question and the "is a human being asked something" question are
# independent; this function is the second one.
[ "${PANE_IDLE_LIB_VERSION:-0}" -ge 3 ] \
  && pass "lib publishes version >= 3 (the codex dialog detector is present)" \
  || fail "lib publishes version >= 3" "got '${PANE_IDLE_LIB_VERSION:-none}'"
if declare -F pane_has_codex_approval_dialog >/dev/null 2>&1; then
  pass "lib defines pane_has_codex_approval_dialog"
else
  fail "lib defines pane_has_codex_approval_dialog"
fi

# POSITIVE. ONE genuine end-to-end `tmux capture-pane -p` of a real Codex
# approval dialog, not spliced and not imagined: a real Codex CLI (v0.149.1) was
# run in a scratch tmux session with `--sandbox read-only --ask-for-approval
# on-request`, in a scratch working directory, and asked through its TUI to run
# `touch approval-dialog-test.txt` -- a write, which read-only plus on-request
# must escalate for. It raised exactly this. The 20-line default window covers
# the dialog comfortably.
CODEX_DIALOG=$'\xe2\x80\xa2 Running touch approval-dialog-test.txt\n\n\n  Would you like to run the following command?\n\n  Environment: local\n\n  Reason: Allow creating the requested empty file approval-dialog-test.txt in the current directory?\n\n  $ touch approval-dialog-test.txt\n\n\xe2\x80\xba 1. Yes, proceed (y)\n  2. Yes, and don\'t ask again for commands that start with `touch approval-dialog-test.txt` (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel'
if pane_has_codex_approval_dialog "$CODEX_DIALOG"; then
  pass "dialog detector: live approval dialog -> yes"
else
  fail "dialog detector: live approval dialog -> yes"
fi

# THE CONTROL, and the entire reason this function exists: check_idle calls that
# SAME pane IDLE. Not a spare assertion about the narrowing -- it is the premise
# the two guards in inbox-push are built on. If it ever flips to busy, the
# esc-to-cancel anchor has been widened back out and every guard that consults
# check_idle first has to be re-read. The detector itself stays correct either
# way, which is the point of asking a separate question.
expect_idle "control: the dialog pane reads IDLE to check_idle" "$CODEX_DIALOG"

# NEGATIVE 1: prose QUOTING the footer, high in the viewport. An agent
# discussing this bug must stay reachable; a whole-pane substring test refuses
# every push to whoever is working on it, silently, for as long as the quote
# stays on screen.
_QUOTE_FILLER=$(for _i in $(seq 1 24); do printf '  ... transcript line %s\n' "$_i"; done)
CODEX_QUOTED=$'I said: the footer is "Press enter to confirm or esc to cancel", which\ncollides with the Gemini busy marker.\n'"$_QUOTE_FILLER"$'\n\xe2\x80\xba Implement {feature}'
if pane_has_codex_approval_dialog "$CODEX_QUOTED"; then
  fail "dialog detector: footer quoted high in the transcript -> no" "matched a quote"
else
  pass "dialog detector: footer quoted high in the transcript -> no"
fi

# NEGATIVE 2, the false positive found by independent review, and the case
# NEGATIVE 1 above cannot express. That one pads 24 filler lines between the
# quote and the composer, which puts the quote entirely OUTSIDE the 20-line tail
# window -- so it grades "a quote far above the tail is excluded" and is
# structurally incapable of failing while the detector is a window test.
#
# This is the same pane with the padding removed: quote four lines up, every line
# of it INSIDE the default window, and a ready composer as the last line. Nothing
# about it is exotic -- a short reply mentioning the literal is far more common
# than one buried two dozen lines up -- and the window test answered "dialog
# pending" for it, so inbox-push refused delivery (skip:dialog-pending) at an
# agent that was idle, reachable, and waiting at a composer. Distance from the
# bottom was never the property; BEING the bottom is.
CODEX_QUOTED_NEAR=$'\xe2\x80\xa2 Right -- the guard looks for Press enter to confirm or esc to cancel\n\n  anywhere inside the tail window, so it refused to deliver here.\n\n\xe2\x80\xba Use /skills to list available skills'
if pane_has_codex_approval_dialog "$CODEX_QUOTED_NEAR"; then
  fail "dialog detector: footer quoted just above a ready composer -> no" \
    "matched a quote inside the tail window"
else
  pass "dialog detector: footer quoted just above a ready composer -> no"
fi
# The mechanism on its own, with the prose taken away: ONE line of anything below
# the footer is enough, because Codex draws a live dialog at the bottom and there
# is nothing under it by construction. Pinned separately so the case above cannot
# pass for an incidental reason (a closing quote mark, the bullet, the wording).
if pane_has_codex_approval_dialog $'  Press enter to confirm or esc to cancel\n\xe2\x80\xba '; then
  fail "dialog detector: any content below the footer -> no" "the footer was not the last line"
else
  pass "dialog detector: any content below the footer -> no"
fi

# NEGATIVE 3: a genuinely busy Codex pane, and NEGATIVE 4: an ordinary idle one
# plus an empty capture. The detector must answer no to both ends of the
# busy/idle axis, or it is just check_idle wearing a different name.
CODEX_BUSY_PANE=$'\xe2\x97\xa6 Working (2s \xe2\x80\xa2 esc to interrupt)\n\n\n\xe2\x80\xba Implement {feature}'
if pane_has_codex_approval_dialog "$CODEX_BUSY_PANE"; then
  fail "dialog detector: genuinely busy codex pane -> no" "matched a busy pane"
else
  pass "dialog detector: genuinely busy codex pane -> no"
fi
if pane_has_codex_approval_dialog $'some transcript\n\n\xe2\x80\xba Implement {feature}'; then
  fail "dialog detector: idle codex pane -> no"
else
  pass "dialog detector: idle codex pane -> no"
fi
if pane_has_codex_approval_dialog ""; then
  fail "dialog detector: empty capture -> no"
else
  pass "dialog detector: empty capture -> no"
fi

# THE WINDOW ITSELF, both sides of the boundary, pinned as a number rather than
# left for the fixtures above to imply. Built by construction rather than by
# counting lines in a fixture by eye.
#
# The padding is BLANK rows, and since the last-line fix it has to be. What the
# window bounds now is how far up the trailing-blank strip reaches; a pane padded
# with CONTENT is not a dialog at any distance (NEGATIVE 2 above -- that IS the
# fix), so content filler can no longer express a boundary at all: both sides of
# it would answer no, and the ceiling cases below would stop distinguishing a
# clamp from a no-op. Blank rows are the honest shape for the property under
# test, and the shape a `capture-pane -p` of a pane taller than its content
# produces (it trims each row's trailing whitespace rather than dropping the
# row).
#
# IT ASSIGNS RATHER THAN PRINTS, which is not a style choice: `$(...)` strips
# trailing newlines, so a printed fixture arrives with its entire padding removed
# and every case below silently grades the un-padded string instead. Worth
# knowing beyond this helper -- inbox-push captures with PANE="$(capture ...)",
# so its panes reach the detector already stripped, and the strip in the library
# is there for callers that do not launder their input that way (a capture read
# from a file, a row of spaces rather than an empty row).
_tail_pane() { # _tail_pane <blank-rows-after-the-footer> -> sets TAIL_PANE
  local n="$1" i
  TAIL_PANE='  Press enter to confirm or esc to cancel'
  for ((i = 1; i <= n; i++)); do TAIL_PANE+=$'\n'; done
}
_tail_pane 19
if pane_has_codex_approval_dialog "$TAIL_PANE"; then
  pass "dialog detector: footer above 19 blank rows -> yes (inside the window)"
else
  fail "dialog detector: footer above 19 blank rows -> yes (inside the window)"
fi
_tail_pane 20
if pane_has_codex_approval_dialog "$TAIL_PANE"; then
  fail "dialog detector: footer above 20 blank rows -> no" "looked outside the window"
else
  pass "dialog detector: footer above 20 blank rows -> no"
fi
# The window is a CALL-time override, not a load-time constant: this library is
# sourced once per process, so a default bound at source time could never be
# moved by a caller or a test afterwards.
_tail_pane 20
if CODEX_DIALOG_TAIL_LINES=25 pane_has_codex_approval_dialog "$TAIL_PANE"; then
  pass "dialog detector: CODEX_DIALOG_TAIL_LINES widens the window at call time"
else
  fail "dialog detector: CODEX_DIALOG_TAIL_LINES widens the window at call time"
fi
# A garbage override falls back to the default instead of crashing `tail` into
# an error whose non-zero exit would read as "no dialog here" -- fail towards
# LOOKING, never towards missing one.
if CODEX_DIALOG_TAIL_LINES="banana" pane_has_codex_approval_dialog "$CODEX_DIALOG"; then
  pass "dialog detector: a garbage window value falls back to the default"
else
  fail "dialog detector: a garbage window value falls back to the default"
fi

# ZERO-WINDOW BYPASS. "0" IS all-digits, so an all-digits-only validation lets
# it straight through, `tail -n 0` emits nothing, and a REAL, currently-on-screen
# dialog reads as "no dialog here" -- exactly backwards from the contract above.
if CODEX_DIALOG_TAIL_LINES=0 pane_has_codex_approval_dialog "$CODEX_DIALOG"; then
  pass "dialog detector: window 0 still detects a real dialog (not a silent bypass)"
else
  fail "dialog detector: window 0 still detects a real dialog (not a silent bypass)" \
    "tail -n 0 emitted nothing and a real dialog read as absent"
fi
# "00" is numerically zero too, and a string compare against the literal "0"
# would have missed it -- the check is on the NUMERIC value.
if CODEX_DIALOG_TAIL_LINES=00 pane_has_codex_approval_dialog "$CODEX_DIALOG"; then
  pass "dialog detector: window 00 (numeric zero) still detects a real dialog"
else
  fail "dialog detector: window 00 (numeric zero) still detects a real dialog"
fi
# UPPER BOUND, proven by actually distinguishing clamped from unclamped rather
# than just asserting "still works": footer at the 250th-from-last row, i.e. 49
# rows OUTSIDE the 200-line ceiling, with the override set to something absurd.
# If the ceiling did not clamp, `tail -n 999999` would simply emit the whole
# (much shorter) input and still find the footer, so the clamp is only
# observable on a fixture whose footer sits beyond 200 but well within the input.
_tail_pane 249
if CODEX_DIALOG_TAIL_LINES=999999 pane_has_codex_approval_dialog "$TAIL_PANE"; then
  fail "dialog detector: an oversized window is clamped to the 200-line ceiling" \
    "matched a footer 250 rows from the bottom -- the clamp did not apply"
else
  pass "dialog detector: an oversized window is clamped to the 200-line ceiling"
fi
# ...and the ceiling is exactly 200, not off-by-one: a footer on the
# 200th-from-last row must still be found with the same huge override.
_tail_pane 199
if CODEX_DIALOG_TAIL_LINES=999999 pane_has_codex_approval_dialog "$TAIL_PANE"; then
  pass "dialog detector: the 200-line ceiling itself catches a footer at line 200"
else
  fail "dialog detector: the 200-line ceiling itself catches a footer at line 200" \
    "clamp is off-by-one (narrower than 200)"
fi

# OVERFLOW, the same bug class as the zero bypass one layer out: a value the
# shell's integer type cannot hold makes the `-eq 0` and `-gt 200` tests
# themselves fail, silenced by their own 2>/dev/null, so neither the fallback
# nor the clamp fires, `tail -n <value>` errors, and a real dialog reads as
# absent again. Twenty nines is comfortably past a 64-bit range.
if CODEX_DIALOG_TAIL_LINES=99999999999999999999 pane_has_codex_approval_dialog "$CODEX_DIALOG"; then
  pass "dialog detector: an out-of-range window still detects a real dialog"
else
  fail "dialog detector: an out-of-range window still detects a real dialog" \
    "the numeric validation itself errored past the integer range, and both fallbacks were silenced"
fi

# Portability guard: BSD/macOS grep has no -P, so a grep -P in bin/ makes the
# call error and the check behind it silently stop working. Linux-only runs
# cannot see that, so assert it statically.
PCRE_HITS=$(grep -rnE 'grep +(-[A-Za-z]*P|[^|]* -[A-Za-z]*P)' "$BIN" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ -n "$PCRE_HITS" ]; then
  fail "portability: no grep -P in bin/" "$PCRE_HITS"
else
  pass "portability: no grep -P in bin/"
fi

# pane_ctx_pct: the bar percentage, and a pipe-delimited segment must not leak
# a percentage into a bar glyph that sits behind a vertical rule.
if [ "$(pane_ctx_pct $'x \xe2\x96\x88\xe2\x96\x91 46%')" = "46" ]; then
  pass "ctx pct: bar glyph then percent"
else
  fail "ctx pct: bar glyph then percent"
fi
if pane_ctx_pct $'\xe2\x96\x88 bar \xe2\x94\x82 46%' >/dev/null; then
  fail "ctx pct: a vertical rule between glyph and percent is not a match"
else
  pass "ctx pct: a vertical rule between glyph and percent is not a match"
fi

echo
echo "pane-idle: $PASS passed, $FAILS failed"
exit "$FAILS"
