#!/usr/bin/env bash
# Tests for bin/pane-idle -- the shared busy/idle classifier, and the two
# composer-identification primitives that joined it at lib v2.
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
# ...and it pins the MINIMUM version, not merely "the lib loaded": against a v1
# lib those two functions are undefined, which check_composer_clean would read
# as "unknown format" and skip every push, forever, in silence.
if grep -q 'PANE_IDLE_LIB_VERSION" -ge 2' "$BIN/inbox-push"; then
  pass "inbox-push asserts a MINIMUM lib version (>=2), not just presence"
else
  fail "inbox-push asserts a MINIMUM lib version (>=2), not just presence"
fi

echo
echo "pane-idle: $PASS passed, $FAILS failed"
exit "$FAILS"
