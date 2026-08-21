#!/usr/bin/env bash
# stuck-pane-sweep.test.sh -- behaviour coverage for bin/stuck-pane-sweep.sh.
#
#   bash packages/base/test/stuck-pane-sweep.test.sh
#
# Every case runs the REAL script as a subprocess against a throwaway sandbox:
# its own HOME, its own fixture directory of pane captures (plain and
# ANSI-preserved), its own state directory, a stub `tmux` on PATH that RECORDS
# every invocation, a stub `sleep` so the escalation settle time costs nothing,
# and the STUCK_MODEL_CMD seam in place of the network. Nothing here can reach a
# live tmux server or a provider.
#
# TWO PROPERTIES ARE SAFETY-RELEVANT AND ARE TESTED AS SUCH, not asserted in
# prose:
#
#   1. REPORT-ONLY IS THE DEFAULT. With no routing configured the sweep must
#      detect, record, and type into nobody's pane. Section 2 proves that from
#      the stub tmux log, which is the only place a keystroke could show up.
#
#   2. THE COMPOSER-PENDING TIER FAILS TOWARD SILENCE. It is calibrated against
#      two runtimes as of 2026-08-20 and is not universal, so an unrecognised
#      composer format must fall through and never produce a finding. Section 4
#      walks the five ways a composer can be unreadable and proves each one is a
#      non-finding rather than a false escalation.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"
SWEEP="${STUCK_SWEEP_BIN:-$BASE/bin/stuck-pane-sweep.sh}"

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL  jq is not on PATH; this suite reads the sweep's own state file"
  echo "stuck-pane-sweep: 0 passed, 1 failed"
  exit 1
fi

# ---- sandbox ---------------------------------------------------------------------
BOX=""
new_box() {
  BOX=$(mktemp -d)
  mkdir -p "$BOX/fixtures" "$BOX/state" "$BOX/stubbin"
  cat > "$BOX/stubbin/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "${1:-}" in
  list-windows) printf '%s\n' ${STUB_WINDOWS:-} ;;
esac
exit 0
EOF
  # The two settle pauses in escalate() are real seconds. Nothing here is timing
  # dependent, so they are stubbed out rather than waited on.
  cat > "$BOX/stubbin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$BOX/stubbin/model-clear" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"verdict":"clear","reason":"resting between turns"}'
EOF
  cat > "$BOX/stubbin/model-stuck" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"verdict":"stuck","reason":"unanswered permission dialog"}'
EOF
  cat > "$BOX/stubbin/model-down" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
exit 1
EOF
  chmod +x "$BOX/stubbin/"*
  : > "$BOX/tmux.log"
}
drop_box() { [ -n "$BOX" ] && rm -rf "$BOX"; BOX=""; }

run_sweep() {
  HOME="$BOX" \
  PATH="$BOX/stubbin:$PATH" \
  TMUX_LOG="$BOX/tmux.log" \
  STUB_WINDOWS="${STUB_WINDOWS:-alice hub deputy}" \
  STUCK_FIXTURE_DIR="$BOX/fixtures" \
  STUCK_STATE_DIR="$BOX/state" \
  bash "$SWEEP" "$@" 2>"$BOX/stderr.txt"
}

pane()     { printf '%s\n' "$2" > "$BOX/fixtures/$1.txt"; }
pane_raw() { printf '%s\n' "$2" > "$BOX/fixtures/$1.raw.txt"; }

s() { jq -r "$1" "$BOX/state/last-stuck-sweep.json" 2>/dev/null; }

# assert <label> <jq-filter> <expected>
assert() {
  local label="$1" filter="$2" want="$3" got
  got=$(s "$filter")
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "got '$got', want '$want'"; fi
}

# no_keystrokes <label>
no_keystrokes() {
  if grep -q 'send-keys' "$BOX/tmux.log" 2>/dev/null; then
    fail "$1" "the stub tmux log holds: $(grep 'send-keys' "$BOX/tmux.log" | head -1)"
  else
    pass "$1"
  fi
}

# keystrokes_to <label> <window>
keystrokes_to() {
  if grep -q "send-keys -t agents:$2 " "$BOX/tmux.log" 2>/dev/null; then
    pass "$1"
  else
    fail "$1" "no send-keys to agents:$2 in $(tr '\n' '|' < "$BOX/tmux.log")"
  fi
}

# ---- pane fixtures ---------------------------------------------------------------
IDLE_PANE=$'  ⎿  Brewed for 39s\n  Done.\n❯ '
BUSY_PANE=$'· Auditing the ledger… (59s · thought for 2s)\n❯ '
DIALOG_PANE=$'  some output\n  Auto mode classifier requires confirmation\n❯ '
RULE='────────────────────────'
# A Claude pane with genuinely staged text: the composer sits under its own rule.
STAGED_PANE=$'  transcript\n'"$RULE"$' alice \n❯ a half-typed line nobody submitted\n'"$RULE"
STAGED_RAW=$'  transcript\n'"$RULE"$' alice \n\033[39m❯ a half-typed line nobody submitted\n'"$RULE"
# The SAME pane with no raw counterpart for the composer line: no evidence.
STAGED_RAW_MISMATCH=$'  transcript\n\033[39m❯ an entirely different line\n'
# Codex idle: the rotating hint is dim chrome, indistinguishable from typed text
# in a plain capture and unmistakable in a raw one.
CODEX_HINT_PANE=$'• Acknowledged. All closed from my side.\n\n› Use /skills to list available skills\n\n  gpt-5.6 default'
CODEX_HINT_RAW=$'• Acknowledged. All closed from my side.\n\n\033[0;1m›\033[0m \033[2mUse /skills to list available skills\033[0m\n\n  gpt-5.6 default'
# An idle Claude composer rests at glyph + U+00A0, which is not [[:space:]] under C.
NBSP=$(printf '\xc2\xa0')
IDLE_NBSP_PANE=$'  transcript\n'"$RULE"$' alice \n❯ '"$NBSP"$'\n'"$RULE"
IDLE_NBSP_RAW=$'  transcript\n'"$RULE"$' alice \n\033[39m❯ '"$NBSP"$'\n'"$RULE"
# No prompt glyph anywhere: a plain shell, or a runtime this tier has never seen.
UNKNOWN_PANE=$'some tool output\nand a second line of it\nno prompt glyph at all'
# Codex collapses a large paste to a fixed placeholder. A POSITIVE literal.
PASTED_PANE=$'  transcript\n'"$RULE"$' alice \n❯ [Pasted Content 1024 chars]\n'"$RULE"

# =================================================================================
# 1. the deterministic literal tier
# =================================================================================
echo "--- deterministic tier ---"

new_box
pane alice "$DIALOG_PANE"
run_sweep >/dev/null
assert "a known dialog fires on the FIRST tick"  '.agents.alice.tier' 'deterministic'
assert "the reason quotes the matched literal" \
  '.agents.alice.reason' 'Auto mode classifier requires confirmation'
assert "the tick verdict is stuck"               '.verdict' 'stuck'
drop_box

new_box
pane alice "$BUSY_PANE"
run_sweep >/dev/null
assert "a busy pane is working, not wedged"      '.agents.alice.busy' '1'
assert "a busy pane is never judged"             '.agents.alice.judged' 'null'
assert "a busy pane costs no model call"         '.modelCalls' '0'
drop_box

# =================================================================================
# 2. REPORT-ONLY IS THE DEFAULT (safety-relevant)
# =================================================================================
echo "--- routing: report-only default ---"

new_box
pane alice "$DIALOG_PANE"
run_sweep >/dev/null
assert "unconfigured routing reports the mode honestly" '.escalationMode' 'report-only'
assert "the finding is still RECORDED"                  '.agents.alice.reason' 'Auto mode classifier requires confirmation'
assert "the episode is marked as reported"              '.agents.alice.escalated' 'true'
assert "there is no route to name"                      '.agents.alice.routedTo' 'null'
assert "the verdict still says stuck"                   '.verdict' 'stuck'
no_keystrokes "an unconfigured install types into NOBODY'S pane"
if [ -s "$BOX/state/stuck-sweep-history.jsonl" ]; then
  pass "report-only still appends to the history log"
else
  fail "report-only still appends to the history log" "no history file"
fi
drop_box

new_box
pane alice "$DIALOG_PANE"
( export STUCK_ROUTE_DEFAULT=hub; run_sweep >/dev/null )
assert "configured routing reports live mode"  '.escalationMode' 'live'
assert "the record names where it went"        '.agents.alice.routedTo' 'hub'
keystrokes_to "a configured route is actually woken" hub
drop_box

new_box
pane alice "$DIALOG_PANE"
( export STUCK_ROUTE_DEFAULT=hub STUCK_NO_ESCALATE=1; run_sweep >/dev/null )
assert "shadow mode overrides configured routing" '.escalationMode' 'report-only'
assert "the finding is still recorded in shadow"  '.agents.alice.tier' 'deterministic'
no_keystrokes "shadow mode wakes nobody even with a route configured"
drop_box

new_box
pane hub "$DIALOG_PANE"
( export STUCK_ROUTE_DEFAULT=hub STUCK_ROUTE_SELF=deputy; run_sweep >/dev/null )
assert "the router's OWN pane routes to the deputy" '.agents.hub.routedTo' 'deputy'
keystrokes_to "the deputy is the one woken about the router's own pane" deputy
if grep -q 'send-keys -t agents:hub ' "$BOX/tmux.log"; then
  fail "a message about a wedged pane is never sent INTO that wedged pane" \
       "$(grep 'send-keys -t agents:hub ' "$BOX/tmux.log" | head -1)"
else
  pass "a message about a wedged pane is never sent INTO that wedged pane"
fi
drop_box

new_box
pane hub "$DIALOG_PANE"
( export STUCK_ROUTE_DEFAULT=hub; run_sweep >/dev/null )
assert "with no deputy the router's own wedge has no route" '.agents.hub.routedTo' 'null'
assert "and it is still recorded"                            '.agents.hub.tier' 'deterministic'
no_keystrokes "with no deputy configured, the router's own wedge falls back to report-only"
drop_box

# =================================================================================
# 3. the composer-pending tier: the positive cases
# =================================================================================
echo "--- composer-pending: positive ---"

new_box
pane alice "$STAGED_PANE"
pane_raw alice "$STAGED_RAW"
run_sweep >/dev/null
assert "staged text does NOT fire on the first sighting" '.agents.alice.tier' 'none'
assert "the first sighting counts one tick"              '.agents.alice.ticks' '1'
run_sweep >/dev/null
assert "staged text fires once the pane has held still"  '.agents.alice.tier' 'composer-pending'
assert "the finding carries the excerpt" \
  '.agents.alice.reason | test("a half-typed line nobody submitted")' 'true'
assert "no model call was needed"                        '.modelCalls' '0'
drop_box

new_box
pane alice "$PASTED_PANE"
run_sweep >/dev/null
run_sweep >/dev/null
assert "a collapsed paste placeholder fires without raw evidence" \
  '.agents.alice.tier' 'composer-pending'
drop_box

new_box
pane alice "$STAGED_PANE"
pane_raw alice "$STAGED_RAW"
run_sweep >/dev/null; run_sweep >/dev/null; run_sweep >/dev/null
assert "an episode is only reported once, however long it lasts" \
  '.agents.alice.escalated' 'true'
COUNT=$(grep -c 'send-keys' "$BOX/tmux.log" 2>/dev/null || true)
[ "${COUNT:-0}" = "0" ] \
  && pass "three ticks of one episode produce no repeat wake (report-only here)" \
  || fail "three ticks of one episode produce no repeat wake" "$COUNT send-keys"
drop_box

# =================================================================================
# 4. FAIL TOWARD SILENCE (safety-relevant)
# =================================================================================
# The tier is calibrated against Claude Code 2.1.236 and Codex as of 2026-08-20
# and is explicitly not universal. Every way a composer can be unreadable must
# produce a NON-FINDING, never a false escalation. The model stub answers "clear"
# throughout, so a tier of "none" proves the composer tier declined rather than
# that nothing ran.
echo "--- composer-pending: fail toward silence ---"

silence_case() {  # <label> <plain fixture> [<raw fixture>]
  new_box
  pane alice "$2"
  [ "$#" -ge 3 ] && pane_raw alice "$3"
  ( export STUCK_MODEL_CMD="$BOX/stubbin/model-clear"; run_sweep >/dev/null; run_sweep >/dev/null )
  local tier reason
  tier=$(s '.agents.alice.tier'); reason=$(s '.agents.alice.reason')
  if [ "$tier" = "none" ] && [ "$reason" = "" ]; then
    pass "$1"
  else
    fail "$1" "tier='$tier' reason='$reason'"
  fi
  no_keystrokes "$1: and nobody was woken"
  drop_box
}

silence_case "an unrecognised composer format is a non-finding" "$UNKNOWN_PANE"
silence_case "an idle composer resting at a no-break space is a non-finding" \
  "$IDLE_NBSP_PANE" "$IDLE_NBSP_RAW"
silence_case "a dim rotating hint is a non-finding" \
  "$CODEX_HINT_PANE" "$CODEX_HINT_RAW"
silence_case "text with NO raw capture at all is a non-finding" "$STAGED_PANE"
silence_case "text whose raw capture has no corresponding line is a non-finding" \
  "$STAGED_PANE" "$STAGED_RAW_MISMATCH"
silence_case "an ordinary finished-turn pane is a non-finding" "$IDLE_PANE"

# =================================================================================
# 5. the model tier
# =================================================================================
echo "--- model tier ---"

new_box
pane alice "$IDLE_PANE"
# THE COST DISCIPLINE, tick by tick. modelCalls is a PER-TICK counter, so the
# three assertions below are the whole claim: a first sighting is not evidence of
# anything and costs nothing; the second tick is the one that pays; every tick
# after that reads the verdict cached against the same hash and pays nothing. An
# agent idling untouched all night therefore costs one call, not one per tick.
( export STUCK_MODEL_CMD="$BOX/stubbin/model-clear"; run_sweep >/dev/null )
assert "tick 1: a first sighting costs nothing"        '.modelCalls' '0'
( export STUCK_MODEL_CMD="$BOX/stubbin/model-clear"; run_sweep >/dev/null )
assert "tick 2: a motionless capture is judged once"   '.modelCalls' '1'
assert "a clear verdict is cached against the capture" '.agents.alice.judged' 'clear'
assert "a clear verdict produces no finding"           '.agents.alice.reason' ''
( export STUCK_MODEL_CMD="$BOX/stubbin/model-clear"; run_sweep >/dev/null )
assert "tick 3: the cached verdict costs nothing more" '.modelCalls' '0'
assert "and it is still the cached verdict"            '.agents.alice.judged' 'clear'
drop_box

new_box
pane alice "$IDLE_PANE"
( export STUCK_MODEL_CMD="$BOX/stubbin/model-stuck"; run_sweep >/dev/null; run_sweep >/dev/null )
assert "a stuck verdict becomes a finding"    '.agents.alice.tier' 'model'
assert "the model's reason is carried"        '.agents.alice.reason | test("unanswered permission dialog")' 'true'
drop_box

new_box
pane alice "$IDLE_PANE"
pane bob   "$IDLE_PANE"
( export STUCK_MODEL_CMD="$BOX/stubbin/model-down"; run_sweep >/dev/null; run_sweep >/dev/null )
assert "an unavailable classifier is ONE fault, not N stuck panes" \
  '[.agents[] | select(.tier == "model-unavailable")] | length' '2'
assert "no pane is claimed stuck on a transport failure" \
  '[.agents[] | select(.reason != "" and .reason != null)] | length' '0'
assert "the outage is visible in the verdict" '.verdict' 'classifier-unavailable'
assert "no fabricated verdict is cached"      '.agents.alice.judged' 'null'
drop_box

# =================================================================================
# 6. the library version pin
# =================================================================================
echo "--- library version pin ---"

new_box
mkdir -p "$BOX/fakebin"
cp "$SWEEP" "$BOX/fakebin/stuck-pane-sweep.sh"
# A v1 library: check_idle is there, the composer primitives are not. Against
# this, composer_pending would answer "not pending" for every pane, silently and
# forever, which is the exact incident the tier exists to prevent.
cat > "$BOX/fakebin/pane-idle" <<'EOF'
check_idle() { return 1; }
pane_ctx_pct() { return 1; }
PANE_IDLE_LIB_VERSION=1
EOF
pane alice "$DIALOG_PANE"
( STUCK_SWEEP_BIN="$BOX/fakebin/stuck-pane-sweep.sh"
  SWEEP="$BOX/fakebin/stuck-pane-sweep.sh"
  run_sweep >/dev/null )
assert "a v1 library refuses the tick rather than going quiet" '.error' 'no-pane-idle-lib'
assert "and it records the version it found"                   '.libVersion' '1'
no_keystrokes "a refused tick wakes nobody"
drop_box

echo
echo "stuck-pane-sweep: $PASS passed, $FAILS failed"
exit "$FAILS"
