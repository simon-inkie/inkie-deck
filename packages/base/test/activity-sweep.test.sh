#!/usr/bin/env bash
# activity-sweep.test.sh -- behaviour coverage for bin/activity-sweep.sh.
#
#   bash packages/base/test/activity-sweep.test.sh
#
# Every case runs the REAL script as a subprocess against a throwaway sandbox:
# its own HOME, its own fixture directory of pane captures, its own inbox root,
# a frozen clock, git disabled, and a stub `tmux` on PATH that records every
# invocation and fails. Nothing here can reach a live tmux server, a live inbox
# or a live repository.
#
# THE STUB TMUX IS ALSO AN ASSERTION. This sweep is an OBSERVER: it must never
# type into a pane. The last case in section 1 proves that mechanically, by
# showing the stub's log holds no send-keys after a full run that classified a
# stuck pane.
#
# What is graded here is the CLASSIFICATION -- the pill cascade, its precedence,
# the windows that make a signal decay, the empty-versus-zero split on the
# sub-agent count -- plus the two contracts a reader depends on (the document
# shape, and the persistence default).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"
SWEEP="${ACTIVITY_SWEEP_BIN:-$BASE/bin/activity-sweep.sh}"

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL  jq is not on PATH, and the sweep refuses to run without it"
  echo "activity-sweep: 0 passed, 1 failed"
  exit 1
fi

NOW_ISO="2026-08-21T12:00:00Z"
NOW_EPOCH="$(date -u -d "$NOW_ISO" +%s)"

# ---- sandbox ---------------------------------------------------------------------
BOX=""
new_box() {
  BOX=$(mktemp -d)
  mkdir -p "$BOX/fixtures" "$BOX/inboxes" "$BOX/activity" "$BOX/state" "$BOX/stubbin"
  : > "$BOX/roots.txt"          # an EMPTY roots config: no worktree candidates
  cat > "$BOX/stubbin/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
exit 1
EOF
  chmod +x "$BOX/stubbin/tmux"
}
drop_box() { [ -n "$BOX" ] && rm -rf "$BOX"; BOX=""; }

run_sweep() {  # extra env may be exported by the caller's subshell
  HOME="$BOX" \
  PATH="$BOX/stubbin:$PATH" \
  TMUX_LOG="$BOX/tmux.log" \
  ACTIVITY_FIXTURE_DIR="$BOX/fixtures" \
  ACTIVITY_ROOT="$BOX/activity" \
  ACTIVITY_STATE_DIR="$BOX/state" \
  ACTIVITY_INBOX_ROOT="$BOX/inboxes" \
  ACTIVITY_ROOTS_CONFIG="$BOX/roots.txt" \
  ACTIVITY_NO_GIT=1 \
  ACTIVITY_NOW="${CASE_NOW:-$NOW_ISO}" \
  ACTIVITY_NOW_EPOCH="${CASE_NOW_EPOCH:-$NOW_EPOCH}" \
  bash "$SWEEP" "$@" 2>"$BOX/stderr.txt"
}

pane() { printf '%s\n' "$2" > "$BOX/fixtures/$1.txt"; }

# thread <agent> <correspondent> -- body of the thread file arrives on stdin.
thread() {
  mkdir -p "$BOX/inboxes/$1/inbox"
  cat > "$BOX/inboxes/$1/inbox/$2.md"
}

q() { jq -r "$1" "$BOX/activity/activity.json" 2>/dev/null; }

# assert <label> <jq-filter> <expected>
assert() {
  local label="$1" filter="$2" want="$3" got
  got=$(q "$filter")
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "got '$got', want '$want'"; fi
}

# ---- pane fixtures ---------------------------------------------------------------
BUSY_PANE=$'· Auditing the ledger… (59s · thought for 2s)\n❯ '
IDLE_PANE=$'  ⎿  Brewed for 39s\n  Done.\n❯ '
STUCK_PANE=$'  some output\n  Auto mode classifier requires confirmation\n❯ '
# The same literal, pushed far above the live viewport by later output. A dialog
# already dealt with must not read as a live wedge.
STUCK_SCROLLBACK=$'Auto mode classifier requires confirmation'
for _i in $(seq 1 30); do STUCK_SCROLLBACK="$STUCK_SCROLLBACK"$'\n  ordinary line of transcript'; done
STUCK_SCROLLBACK="$STUCK_SCROLLBACK"$'\n❯ '
# A live UI region listing two running sub-agents. The anchor is the switcher
# hint; the COUNT comes from the rows below it, never from the hint's own number.
SUBAGENTS_PANE=$'  ⎿  Brewed for 39s\n  auto-accept edits on (shift+tab to cycle) ← 1 agent\n  ◯ general-purpose  reviewing   1m 4s\n  ◯ general-purpose  searching   12s\n❯ '
# The region is present and lists NOTHING. Distinct from "no region at all".
SUBAGENTS_ZERO_PANE=$'  ⎿  Brewed for 39s\n  auto-accept edits on (shift+tab to cycle) ← 1 agent\n❯ '

# ---- thread helpers --------------------------------------------------------------
# The three protocol separators, built rather than written, for the same reason
# the sweep builds them: this repository refuses a literal U+2014 in source.
DASH_EM=$(printf '\xe2\x80\x94')
DASH_EN=$(printf '\xe2\x80\x93')

# hdr <ts> <from> <status> <subject> [<separator>]
hdr() { printf '## %s %s from: %s %s status: %s %s subject: %s\n' \
          "$1" "${5:--}" "$2" "${5:--}" "$3" "${5:--}" "$4"; }

# =================================================================================
# 1. the pill cascade and its precedence
# =================================================================================
echo "--- pill cascade ---"

new_box
pane alice "$BUSY_PANE"
run_sweep >/dev/null
assert "busy pane -> working"            '.agents.alice.status' 'working'
assert "busy pane -> signal pane-busy"   '.agents.alice.signal' 'pane-busy'
assert "busy pane -> busy true"          '.agents.alice.busy'   'true'
drop_box

new_box
pane alice "$STUCK_PANE"
run_sweep >/dev/null
assert "stuck literal in the live tail -> stuck" '.agents.alice.status' 'stuck'
assert "stuck evidence quotes the literal" \
  '.agents.alice.evidence | test("Auto mode classifier requires confirmation")' 'true'
assert "stuck evidence says escalation is NOT this sweep's" \
  '.agents.alice.evidence | test("reported only")' 'true'
# THE OBSERVER NEVER ACTS. A full run that classified a stuck pane must not have
# reached tmux at all, let alone sent a keystroke.
if [ ! -s "$BOX/tmux.log" ]; then
  pass "observer never invokes tmux in fixture mode (no log at all)"
elif ! grep -q 'send-keys' "$BOX/tmux.log"; then
  pass "observer never sends keys, even having found a stuck pane"
else
  fail "observer never sends keys, even having found a stuck pane" "$(cat "$BOX/tmux.log")"
fi
drop_box

new_box
pane alice "$STUCK_SCROLLBACK"
run_sweep >/dev/null
assert "stuck literal above the live viewport -> NOT stuck" '.agents.alice.status' 'done-for-now'
drop_box

new_box
pane alice "$SUBAGENTS_PANE"
thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
run_sweep >/dev/null
assert "running sub-agents outrank an open card" '.agents.alice.status' 'waiting-on-machine'
assert "sub-agent count is published"             '.agents.alice.subagentCount' '2'
assert "sub-agent evidence names the count" \
  '.agents.alice.evidence | test("2 running sub-agent")' 'true'
drop_box

new_box
pane alice "$SUBAGENTS_ZERO_PANE"
thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
run_sweep >/dev/null
assert "a region listing NOTHING publishes 0, not null" '.agents.alice.subagentCount' '0'
assert "a zero count does not outrank the card"          '.agents.alice.status' 'needs-you'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
run_sweep >/dev/null
assert "no live UI region publishes null, not 0" '.agents.alice.subagentCount' 'null'
assert "open decision card -> needs-you"          '.agents.alice.status' 'needs-you'
assert "needs-you evidence names the correspondent" \
  '.agents.alice.evidence | test("to hub")' 'true'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
answered: A
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.

$(hdr 2026-08-21T09:05:00Z hub read "re: please decide")

Answered: A.
EOF
run_sweep >/dev/null
assert "an answered card is not open"   '.agents.alice.status' 'done-for-now'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please act")
action-id: A-1
priority: high

Do the thing.

$(hdr 2026-08-21T09:30:00Z alice sent "and this one")
action-id: A-2
done: 2026-08-21T09:45:00Z

Done already.
EOF
run_sweep >/dev/null
assert "an action card is a card too"        '.agents.alice.status' 'needs-you'
assert "a done: action card does not count"  '.agents.alice.evidence | test("A-1")' 'true'
drop_box

# ---- the terminal-key vocabulary (docs/protocol.md 7.1.1) ------------------------
# Three terminal keys per card kind, overlapping only on `dismissed:`. What is
# graded below is the WHOLE set, in both directions, because the two failures
# available here are opposite and both bad: a missing terminal key leaves a
# closed card driving the needs-you pill for the rest of its 72h window, and a
# spurious one silently closes a card nobody answered.

# THE EXPECTED PILL FOR A CLOSED CARD IS `waiting-on-teammate`, NOT
# `done-for-now`, and that is the assertion rather than an accident of the
# fixture. Each thread below ends with an outbound block from the agent, so once
# the card stops counting as open the cascade falls through to the last-block
# rule, which reads exactly that. Asserting the pill it lands on is stricter than
# asserting "not needs-you": it proves the card left the needs-you branch AND
# that nothing else picked it up.
#
# card_case <label> <expected status> -- the card block arrives on stdin.
card_case() {
  new_box
  pane alice "$IDLE_PANE"
  thread alice hub
  run_sweep >/dev/null
  assert "$1" '.agents.alice.status' "$2"
  drop_box
}

card_case "a superseded decision is not open" waiting-on-teammate <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-SUP
superseded: 2026-08-21T09:40:00Z
supersede-note: "asked a better question instead"
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF

card_case "a superseded action is not open" waiting-on-teammate <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please act")
action-id: A-SUP
superseded: 2026-08-21T09:40:00Z

Do the thing.
EOF

card_case "a dismissed decision is not open" waiting-on-teammate <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-DIS
dismissed: 2026-08-21T09:40:00Z
dismiss-reason: "overtaken by events"
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF

card_case "a dismissed action is not open" waiting-on-teammate <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please act")
action-id: A-DIS
dismissed: 2026-08-21T09:40:00Z

Do the thing.
EOF

# `custom-answer:` IS NOT A TERMINAL KEY. It is the payload that accompanies
# `answered: custom`, and the reference writer never emits one without the
# other. Reading it alone as a resolution closes a card nobody answered, which
# is the same failure as reading an empty `answered:` placeholder as an answer.
card_case "a bare custom-answer, with no answered line, does NOT close the card" needs-you <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-HALF
custom-answer: "half-written, or written by something that crashed"
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF

card_case "the pair that the writer actually emits DOES close it" waiting-on-teammate <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-CUSTOM
answered: custom
custom-answer: "neither, do the third thing"
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF

# The sets are PER KIND, not one pooled list. A decision has no `done:` state,
# so an action key on a decision card is a malformed block rather than a
# resolution, and the safe reading of a malformed card is "still open".
card_case "an action terminal key on a decision card does not close it" needs-you <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-WRONGKEY
done: 2026-08-21T09:40:00Z
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF

card_case "a decision terminal key on an action card does not close it" needs-you <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please act")
action-id: A-WRONGKEY
answered: A

Do the thing.
EOF

new_box
pane alice "$IDLE_PANE"
# Older than CARD_WINDOW_H (72h) from the frozen clock.
thread alice hub <<EOF
$(hdr 2026-08-11T09:00:00Z alice sent "ancient")
decision-id: D-OLD
options:
  - key: A
    label: yes
    detail: ship it

Long forgotten.
EOF
run_sweep >/dev/null
assert "a card outside the window stops driving the pill" '.agents.alice.status' 'done-for-now'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T11:00:00Z alice sent "can you look at this")

Any thoughts on the parser?
EOF
run_sweep >/dev/null
assert "unread outbound to a teammate -> waiting-on-teammate" '.agents.alice.status' 'waiting-on-teammate'
assert "wait evidence states the raw observation" \
  '.agents.alice.evidence | test("still unread by bob")' 'true'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T11:00:00Z alice sent "wrapping up")

Done. Merged and closed from my side.
EOF
run_sweep >/dev/null
assert "a completion sign-off is NOT a wait" '.agents.alice.status' 'done-for-now'
drop_box

new_box
pane alice "$IDLE_PANE"
# Older than WAIT_MAX_MIN (240 minutes) from the frozen clock.
thread alice bob <<EOF
$(hdr 2026-08-21T04:00:00Z alice sent "old ask")

Any thoughts on the parser?
EOF
run_sweep >/dev/null
assert "an unread outbound past the decay window stops firing" '.agents.alice.status' 'done-for-now'
drop_box

new_box
pane alice "$IDLE_PANE"
run_sweep >/dev/null
assert "idle with nothing outstanding -> done-for-now" '.agents.alice.status' 'done-for-now'
assert "done-for-now signal"                           '.agents.alice.signal' 'idle-no-signal'
drop_box

new_box
: > "$BOX/fixtures/alice.txt"   # a window that produced no pane text at all
run_sweep >/dev/null
assert "an empty capture is a REFUSAL, not a verdict" '.agents.alice.status' 'unknown'
assert "unknown carries the no-pane signal"           '.agents.alice.signal' 'no-pane'
drop_box

# =================================================================================
# 2. ACTIVITY_HUMANS: unset means unrestricted, not disabled
# =================================================================================
echo "--- human-correspondent configuration ---"

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
run_sweep >/dev/null
assert "unset HUMANS: a card to anyone still fires needs-you" '.agents.alice.status' 'needs-you'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
( export ACTIVITY_HUMANS="dana"; run_sweep >/dev/null )
assert "configured HUMANS: a card to a non-person stops driving needs-you" \
  '.agents.alice.status' 'waiting-on-teammate'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice dana <<EOF
$(hdr 2026-08-21T11:00:00Z alice sent "status note")

Here is where I got to today.
EOF
( export ACTIVITY_HUMANS="dana"; run_sweep >/dev/null )
assert "configured HUMANS: a person not reading a note is not a block" \
  '.agents.alice.status' 'done-for-now'
drop_box

# =================================================================================
# 3. the protocol's three header separators
# =================================================================================
echo "--- header separators ---"

for sep_name in hyphen emdash endash; do
  case "$sep_name" in
    hyphen) SEP="-" ;;
    emdash) SEP="$DASH_EM" ;;
    endash) SEP="$DASH_EN" ;;
  esac
  new_box
  pane alice "$IDLE_PANE"
  thread alice hub <<EOF
$(hdr 2026-08-21T09:00:00Z alice sent "please decide" "$SEP")
decision-id: D-1
options:
  - key: A
    label: yes
    detail: ship it

Waiting on you.
EOF
  run_sweep >/dev/null
  assert "header separator: $sep_name parses" '.agents.alice.status' 'needs-you'
  drop_box
done

# =================================================================================
# 4. the document contract two readers depend on
# =================================================================================
echo "--- document contract ---"

new_box
pane alice "$IDLE_PANE"
pane bob   "$BUSY_PANE"
run_sweep >/dev/null
assert "schema is 1"                 '.schema' '1'
assert "generator names this sweep"  '.generator' 'activity-sweep'
assert "swept is the frozen clock"   '.swept' "$NOW_ISO"
assert "roots provenance is honest"  '.worktreeRootsSource' 'config'
assert "both windows are recorded"   '.agents | keys | join(",")' 'alice,bob'
assert "a record with no worktree says so, rather than guessing" \
  '.agents.alice.worktree.confidence' 'none'
assert "notes report the empty candidate set" \
  '.notes | any(test("no candidate worktrees"))' 'true'
assert "statusSince is emitted"      '.agents.alice.statusSince' "$NOW_ISO"
assert "an idle record carries idleMinutes" '.agents.alice.idleMinutes' '0'
# Shadow is the default mode, and shadow must merge NOTHING into the document.
assert "no inference is merged in the default mode" \
  '[.. | objects | select(has("inference"))] | length' '0'
assert "no inferenceMeta in the default mode" '.inferenceMeta // "absent"' 'absent'
if [ -f "$BOX/activity/merge-preview.json" ]; then
  pass "shadow writes its computed merge to the preview file instead"
else
  fail "shadow writes its computed merge to the preview file instead" "no merge-preview.json"
fi
drop_box

# =================================================================================
# 5. statusSince carries forward only while the status holds
# =================================================================================
echo "--- status duration ---"

new_box
pane alice "$IDLE_PANE"
run_sweep >/dev/null
FIRST_SINCE=$(q '.agents.alice.statusSince')
LATER_ISO="2026-08-21T12:30:00Z"
LATER_EPOCH=$(date -u -d "$LATER_ISO" +%s)
( export CASE_NOW="$LATER_ISO" CASE_NOW_EPOCH="$LATER_EPOCH"; run_sweep >/dev/null )
assert "an unchanged status keeps its original since-instant" '.agents.alice.statusSince' "$FIRST_SINCE"
assert "the sweep timestamp still advances"                   '.swept' "$LATER_ISO"
pane alice "$BUSY_PANE"
( export CASE_NOW="$LATER_ISO" CASE_NOW_EPOCH="$LATER_EPOCH"; run_sweep >/dev/null )
assert "a changed status resets the since-instant"            '.agents.alice.statusSince' "$LATER_ISO"
drop_box

# =================================================================================
# 6. refusals: never publish an empty document over a good one
# =================================================================================
echo "--- refusals ---"

new_box
pane alice "$IDLE_PANE"
run_sweep >/dev/null
BEFORE=$(cat "$BOX/activity/activity.json")
rm -f "$BOX/fixtures/alice.txt"    # zero windows
run_sweep >/dev/null
AFTER=$(cat "$BOX/activity/activity.json")
if [ "$BEFORE" = "$AFTER" ]; then
  pass "zero windows leaves the previous document untouched"
else
  fail "zero windows leaves the previous document untouched" "the file changed"
fi
V=$(jq -r '.verdict // ""' "$BOX/state/last-activity-sweep.json" 2>/dev/null)
E=$(jq -r '.error // ""' "$BOX/state/last-activity-sweep.json" 2>/dev/null)
[ "$V" = "error" ] && [ "$E" = "no-windows" ] \
  && pass "the health file names the refusal (no-windows)" \
  || fail "the health file names the refusal (no-windows)" "verdict='$V' error='$E'"
drop_box

new_box
pane alice "$IDLE_PANE"
( export ACTIVITY_SKIP_AGENTS="alice"; run_sweep >/dev/null )
if [ ! -f "$BOX/activity/activity.json" ]; then
  pass "a skip list covering the whole roster refuses rather than publishing {}"
else
  fail "a skip list covering the whole roster refuses rather than publishing {}" \
       "$(jq -c '.agents' "$BOX/activity/activity.json")"
fi
E=$(jq -r '.error // ""' "$BOX/state/last-activity-sweep.json" 2>/dev/null)
[ "$E" = "no-agents-swept" ] \
  && pass "the second guard reports a DISTINCT reason (no-agents-swept)" \
  || fail "the second guard reports a DISTINCT reason (no-agents-swept)" "error='$E'"
drop_box

new_box
pane alice "$IDLE_PANE"
( export ACTIVITY_MODEL_MODE="nonsense"; run_sweep >/dev/null )
E=$(jq -r '.error // ""' "$BOX/state/last-activity-sweep.json" 2>/dev/null)
[ "$E" = "bad-model-mode" ] \
  && pass "a bad model mode fails the tick closed, by name" \
  || fail "a bad model mode fails the tick closed, by name" "error='$E'"
drop_box

new_box
pane alice "$IDLE_PANE"
( export ACTIVITY_SIGNAL_BYTES="not-a-number"; run_sweep >/dev/null )
E=$(jq -r '.error // ""' "$BOX/state/last-activity-sweep.json" 2>/dev/null)
[ "$E" = "bad-signal-constant" ] \
  && pass "a bound that would not bind fails the tick closed" \
  || fail "a bound that would not bind fails the tick closed" "error='$E'"
drop_box

# =================================================================================
# 7. the signals digest: OFF by default in this package
# =================================================================================
echo "--- signals digest ---"

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T11:00:00Z bob sent "a question")

What is the state of the parser work?
EOF
run_sweep >/dev/null
if [ ! -e "$BOX/activity/signals/alice.txt" ]; then
  pass "no digest is written to disk by default"
else
  fail "no digest is written to disk by default" "$BOX/activity/signals/alice.txt exists"
fi
assert "signalHash is null when no digest reached disk" '.agents.alice.signalHash' 'null'
assert "the deterministic unread count is still published" '.agents.alice.inboxUnreadInbound' '1'
drop_box

new_box
pane alice "$IDLE_PANE"
thread alice bob <<EOF
$(hdr 2026-08-21T11:00:00Z bob sent "a question")

What is the state of the parser work?
EOF
( export ACTIVITY_SIGNAL_PERSIST=1; run_sweep >/dev/null )
if [ -f "$BOX/activity/signals/alice.txt" ]; then
  pass "opting in writes the digest"
else
  fail "opting in writes the digest" "no file at $BOX/activity/signals/alice.txt"
fi
H=$(q '.agents.alice.signalHash')
[ "$H" != "null" ] && [ -n "$H" ] \
  && pass "the published hash backs a digest that is actually on disk" \
  || fail "the published hash backs a digest that is actually on disk" "signalHash='$H'"
MODE=$(stat -c '%a' "$BOX/activity/signals/alice.txt" 2>/dev/null)
[ "$MODE" = "600" ] && pass "the digest is written 0600" \
  || fail "the digest is written 0600" "mode=$MODE"
if grep -q 'unread inbound: 1' "$BOX/activity/signals/alice.txt"; then
  pass "the digest carries the summary lines first"
else
  fail "the digest carries the summary lines first" "$(head -3 "$BOX/activity/signals/alice.txt")"
fi
drop_box

new_box
pane alice "$IDLE_PANE"
( export ACTIVITY_SIGNAL_PERSIST=1 ACTIVITY_SIGNALS_DIR="$BOX/activity/signals"
  run_sweep >/dev/null
  # A refused refresh must not leave an earlier digest behind to be mistaken for
  # this tick's. Break the write by making the target a directory.
  rm -f "$BOX/activity/signals/alice.txt"
  mkdir -p "$BOX/activity/signals/alice.txt"
  run_sweep >/dev/null )
assert "a refused write publishes no signalHash" '.agents.alice.signalHash' 'null'
assert "the refusal is recorded in notes" \
  '.notes | any(test("signals digest refused for alice"))' 'true'
drop_box

# =================================================================================
# 8. the model-layer sidecar is strictly additive
# =================================================================================
echo "--- sidecar tolerance ---"

new_box
pane alice "$IDLE_PANE"
printf 'this is not json at all\n' > "$BOX/activity/inferences.json"
run_sweep >/dev/null
assert "a malformed sidecar still produces a document" '.agents.alice.status' 'done-for-now'
F=$(jq -r '.inferenceMeta.sidecarFault // ""' "$BOX/activity/merge-preview.json" 2>/dev/null)
[ "$F" = "malformed-record" ] \
  && pass "the malformed sidecar is named in the preview's fault field" \
  || fail "the malformed sidecar is named in the preview's fault field" "fault='$F'"
drop_box

new_box
pane alice "$IDLE_PANE"
cat > "$BOX/activity/inferences.json" <<EOF
{"inferenceMeta":{"schema":99},"agents":{"alice":{"taskLine":"something"}}}
EOF
run_sweep >/dev/null
F=$(jq -r '.inferenceMeta.sidecarFault // ""' "$BOX/activity/merge-preview.json" 2>/dev/null)
[ "$F" = "unknown-schema" ] \
  && pass "an unknown sidecar schema publishes nothing and says why" \
  || fail "an unknown sidecar schema publishes nothing and says why" "fault='$F'"
assert "no prose leaks from an unknown-schema sidecar" \
  '[.. | strings | select(. == "something")] | length' '0'
drop_box

# =================================================================================
# 9. dry run writes nothing
# =================================================================================
echo "--- dry run ---"

new_box
pane alice "$STUCK_PANE"
OUT=$( export ACTIVITY_DRY_RUN=1; run_sweep )
if [ ! -f "$BOX/activity/activity.json" ]; then
  pass "a dry run writes no document"
else
  fail "a dry run writes no document" "activity.json exists"
fi
case "$OUT" in
  *"AGENT alice: stuck"*) pass "a dry run prints the decision it would have written" ;;
  *) fail "a dry run prints the decision it would have written" "$OUT" ;;
esac
drop_box

echo
echo "activity-sweep: $PASS passed, $FAILS failed"
exit "$FAILS"
