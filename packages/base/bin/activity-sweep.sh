#!/usr/bin/env bash
# activity-sweep.sh -- the deterministic producer for the agent-activity view.
#
# It answers one question, once a tick, for every agent window in the tmux
# session: "what IS this agent doing right now, in which worktree, and what did
# it just finish". It writes ONE file, `$ACTIVITY_ROOT/activity.json`, and two
# independent readers consume it: `bin/activity` (the query CLI in this same
# package) and the status panel in `packages/deck`.
#
# WHAT IT NEVER DOES: act. This sweep escalates nothing, pastes nothing, wakes
# nobody. It writes a file. A pane it labels `stuck` is still entirely
# `bin/stuck-pane-sweep.sh`'s business to escalate; reporting the pill here must
# never become a second, competing escalation path into the same pane.
#
# THOSE TWO SCRIPTS ARE DELIBERATELY SEPARATE SYSTEMS, and the split is a
# safety property rather than a file-layout preference. This one OBSERVES and
# never escalates. That one is the sole ACTUATOR, and this one only ever feeds
# it evidence. Do not fold them together, and do not add an escalation path
# here because it would be convenient: two escalators into one pane is a wake
# storm with two authors and no owner.
#
# IT CAPTURES ITS OWN PANES, ON PURPOSE. Sharing one capture with the
# stuck-pane sweep is an obvious saving and a real coupling, and coupling an
# observer to an actuator is the thing the separation above exists to prevent.
# The duplication is deliberate, not an oversight.
#
# EVERY PILL IS DETERMINISTIC. There are no model calls in this script at all,
# and no seam through which one could appear silently. Every pill comes from a
# signal bash can literally observe, and every pill carries an EVIDENCE line so
# a wrong inference is inspectable rather than merely wrong.
#
# STATUS PILLS, first match wins. The ORDER encodes a rule, not a preference.
# The first three tested branches (working, stuck, waiting-on-machine) are
# DIRECT PANE OBSERVATIONS: what the terminal is literally showing right now.
# The next two (needs-you, waiting-on-teammate) are INBOX INFERENCES: what a
# thread implies about who is blocked on whom. done-for-now is the fallthrough
# and tests nothing. Direct observation outranks inference, and a new branch
# belongs at the END of whichever of those two groups it is a member of.
#
#   working             pane is mid-turn (bin/pane-idle says busy)
#   stuck               idle + a known stuck-shape literal in the live tail
#   waiting-on-machine  idle + direct evidence of an armed background machine
#                       process this agent is waiting on. Today that evidence is
#                       exactly one thing: sub-agents this agent dispatched,
#                       counted off the live UI region's rows. See the gap note
#                       below for what is and is NOT in scope.
#   needs-you           idle + an unanswered decision/action card
#   waiting-on-teammate idle + their own last message in a teammate thread is
#                       still unread by that teammate, and is not a sign-off.
#                       KNOWN IMPRECISION: "unread" is a proxy for "blocked",
#                       and it over-fires on a message that needed no reply. The
#                       sign-off filter removes the largest wrong class; the rest
#                       is left visible rather than papered over, and the
#                       evidence line states the raw observation ("still unread
#                       by X") not the inference, so a reader can judge it.
#   done-for-now        idle, nothing outstanding
#   unknown             NOT a taxonomy pill: the sentinel for "no observation",
#                       used when a window produced no pane text at all. It is a
#                       refusal to answer, deliberately distinct from any claim.
#
# KNOWN GAP -- waiting-on-machine. The pill was originally defined as "idle +
# evidence of an armed CI/pipeline monitor" and was emitted nowhere, because
# nothing bash could see supplied that evidence. Half of that is no longer true,
# so the definition above is the general one and the two sub-cases are tracked
# separately:
#
#   (a) THE AGENT'S OWN SUB-AGENTS -- CLOSED. The live UI region lists them, one
#       row each, and the sweep counts them (parse_subagent_count). That is
#       direct, per-tick evidence read off the SAME capture as `busy` and the
#       stuck-pattern match, so it is exactly as direct as the two signals ranked
#       above it. It is not an inference from a URL, and it goes away by itself
#       the tick the sub-agents finish. Before this branch existed the count was
#       parsed, published and then ignored by the classifier, so an agent
#       idle-waiting on work IT dispatched was reported `needs-you` on the
#       strength of any open card, and the panel escalated that to a human.
#
#   (b) CI / PIPELINE MONITORS -- STILL OPEN, and still never faked:
#       - an in-session watcher lives inside the agent's own runtime session. The
#         process it spawns carries no agent identity, so even when one IS
#         running there is no way to attribute it to a window.
#       - a merge-request URL in an inbox message does not distinguish "waiting
#         on CI right now" from "merged an hour ago", and every agent's thread is
#         full of both.
#       The honest routes remain what they were: an agent self-declaring
#       `waiting-on: <url>` into its own silo, or a model layer reading the
#       signals digest. Matching a URL would be exactly the wrong-AND-confident
#       failure this design rules out, on the single most common wait state
#       there is.
#
# Test/dry-run seams (no live tmux, no writes, no network):
#   ACTIVITY_FIXTURE_DIR=<dir>   pane text from <dir>/<window>.txt instead of tmux
#   ACTIVITY_DRY_RUN=1           print decisions, write nothing
#   ACTIVITY_ROOT=<dir>          state home (default $HOME/.the-vault/activity)
#   ACTIVITY_FILE=<path>         override activity.json's path directly
#   ACTIVITY_STATE_DIR=<dir>     where the health file and the shared stuck-shape
#                                list live. Defaults to a SIBLING of the inbox
#                                root rather than to somewhere inside
#                                ACTIVITY_ROOT, because the stuck-shape list is
#                                shared with bin/stuck-pane-sweep.sh, which has
#                                no ACTIVITY_ROOT of its own.
#   ACTIVITY_STATE_FILE=<path>   override the health file directly
#   ACTIVITY_INBOX_ROOT=<dir>    inbox root; OUTRANKS an ambient INBOX_ROOT so a
#                                test can never accidentally read live inboxes
#   ACTIVITY_ROOTS_CONFIG=<path> worktree-roots config (see load_roots)
#   ACTIVITY_PATTERN_CONFIG=<p>  stuck-shape literals (shared with the sibling)
#   ACTIVITY_PINS_FILE=<path>    worktree pin overrides
#   ACTIVITY_TMUX_SESSION=<name> tmux session holding the agent windows (agents)
#   ACTIVITY_SKIP_AGENTS="a b"   windows to ignore entirely (default: none)
#   ACTIVITY_HUMANS="a b"        correspondents that are PEOPLE (default: none;
#                                see the block where it is read for what an
#                                unset value means, which is not "disabled")
#   ACTIVITY_NO_GIT=1            never shell out to git (scorer still works; it
#                                reads .git/HEAD as a file, not via git)
#   ACTIVITY_NOW=<iso>           freeze the clock (with ACTIVITY_NOW_EPOCH).
#   ACTIVITY_NOW_EPOCH=<n>       DOUBLE-KEYED: both are IGNORED unless
#                                ACTIVITY_FIXTURE_DIR is also set. A single-key
#                                clock override is a silent substitution channel,
#                                and this sweep's freshness contract is entirely
#                                arithmetic on a clock.
#
# MODEL-LAYER PLUMBING. A model layer that writes one prose sentence per agent is
# a natural companion to this sweep, and it is NOT part of this package. What IS
# here is the deterministic plumbing such a layer needs, because the plumbing is
# the half with the safety properties in it and it has to live with the producer:
#   1. two hashes per agent (contextHash/bundleHash) so a model layer can tell
#      "is the prose still about the same thing" from "is it worth a call";
#   2. a bounded, redacted signals digest persisted to disk, so a model layer
#      never needs a second reader of the inbox or the repository;
#   3. the freshness verdict (`current`/`staleReason`) over such a layer's
#      sidecar, and the one decision about whether its output is published at all.
# The sweep reads the sidecar if one exists and ignores it entirely if it does
# not. An absent, malformed or unknown-schema sidecar changes no pill, publishes
# no prose, and never errors the tick.
#
#   ACTIVITY_MODEL_MODE=off|shadow|live   default off. Placement decision ONLY:
#                                `live` merges the computed inference into
#                                activity.json; anything else writes it to
#                                merge-preview.json (0600) and publishes nothing.
#   ACTIVITY_INFERENCES_FILE=<p> the model layer's sidecar
#   ACTIVITY_MERGE_PREVIEW_FILE=<p>
#   ACTIVITY_MAX_AGE_MIN=<n>     staleness upper bound, default 360
#   ACTIVITY_STALE_PROSE_MAX_AGE_MIN=<n>  ceiling on RETAINED (stale but marked)
#                                prose, default 360; must be <= ACTIVITY_MAX_AGE_MIN
#   ACTIVITY_SIGNAL_GRACE_MIN=<n>  signal-grace window, default 30 (0 = off)
#   ACTIVITY_CLOCK_SKEW_TOL_SEC=<n>  staleness lower bound, default 120
#
# NO TERMINAL TEXT IS EVER WRITTEN TO DISK by this system. `busy`, `paneHash` and
# the pane age all exist, because they power the deterministic pill, idle
# detection and the stuck-pattern match; the pane text itself never leaves the
# process. The one corpus this sweep persists is the SIGNALS DIGEST: a per-agent
# summary assembled from what it already parses (inbox messages in both
# directions with their read status, open cards, unread-inbound count, wait
# state) plus git activity (recent commits and the uncommitted-file list). A pane
# repaints on every keystroke; inbox and git move when the WORK moves, which is
# what makes the digest the more honest input of the two.
#
#   ACTIVITY_SIGNALS_DIR=<dir>   persisted signals digests (0700, files 0600)
#   ACTIVITY_SIGNAL_PERSIST=1    ENABLE digest persistence. DEFAULT IS 0 HERE,
#                                and that is the one behavioural difference from
#                                the deployment this was extracted from. Nothing
#                                in this package reads a digest: the model layer
#                                that consumes them is not part of it. Writing
#                                bounded excerpts of every message an agent has
#                                exchanged to disk, by default, for a reader that
#                                does not exist, is a privacy cost with no
#                                benefit attached. Turn it on when you have
#                                something reading them.
#   ACTIVITY_SIGNAL_MSGS_MAX=<n>      message lines across ALL threads, default 10
#   ACTIVITY_SIGNAL_MSG_EXCERPT=<n>   chars of first body line per message, default 120
#   ACTIVITY_SIGNAL_SUBJECT_MAX=<n>   chars of subject per message, default 60
#   ACTIVITY_SIGNAL_CARDS_MAX=<n>     open-card lines, default 3
#   ACTIVITY_SIGNAL_DIRTY_MAX=<n>     porcelain lines, default 20
#   ACTIVITY_SIGNAL_COMMITS_MAX=<n>   commit lines, default 5
#   ACTIVITY_SIGNAL_BYTES=<n>         whole-digest byte cap, default 4800
#   ACTIVITY_SIGNAL_GIT_TIMEOUT_SEC=<n>  wall-clock bound on the porcelain fork,
#                                default 5. This sweep is meant to run every
#                                minute and a cold or huge index can make one
#                                `git status` take seconds, so a dozen of them
#                                serially is a real risk of never finishing a
#                                tick. A timeout drops that agent's dirty list
#                                and records it in `notes`; it is never silent.
#   ACTIVITY_REDACT_CMD=<cmd>    test-only redactor seam; honoured ONLY when
#                                ACTIVITY_FIXTURE_DIR is set, same double-key
#                                reasoning as the clock override
#
# Env prefix is ACTIVITY_, never STUCK_ or SWEEP_. Two sweeps in this package can
# be scheduled on the same box, and a shared SWEEP_DRY_RUN would silently neuter
# whichever one you were not thinking about. stuck-pane-sweep.sh documents the
# same reasoning.
set -u

# Schedulers and supervisors run with a minimal PATH that often omits
# ~/.local/bin, where jq is commonly installed. jq is load-bearing here, so its
# absence is a loud refusal, not a degrade.
export PATH="$HOME/.local/bin:$PATH"

SELF="activity-sweep"

# --- state home ------------------------------------------------------------------
# ACTIVITY_ROOT is a root of its own, a sibling of INBOX_ROOT rather than
# something inside another application's data directory: there are two
# independent readers of this file and neither should be reaching into the
# other's storage. The default is the $HOME-relative form, so the mechanism
# carries no hardcoded absolute path.
ACTIVITY_ROOT="${ACTIVITY_ROOT:-$HOME/.the-vault/activity}"
ACTIVITY_FILE="${ACTIVITY_FILE:-$ACTIVITY_ROOT/activity.json}"
PINS_FILE="${ACTIVITY_PINS_FILE:-$ACTIVITY_ROOT/pins.json}"
ROOTS_CONFIG="${ACTIVITY_ROOTS_CONFIG:-$ACTIVITY_ROOT/worktree-roots.txt}"

# Health file lives with the other sweep's state, so "did the sweeps run" is one
# directory listing for both.
STATE_DIR="${ACTIVITY_STATE_DIR:-$HOME/.the-vault/sweep-state}"
STATE_FILE="${ACTIVITY_STATE_FILE:-$STATE_DIR/last-activity-sweep.json}"

# Stuck-shape literals. SHARED FILE with stuck-pane-sweep.sh, read-if-present and
# never required, so adding a shape once updates both sweeps. When it is absent
# we fall back to the single literal that is also the sibling's built-in default.
# That one string is a KNOWING duplication: reading it out of the sibling's
# source would couple an observer to an actuator, and an empty list would leave
# the `stuck` pill permanently dead on a fresh install. One string, with the
# shared config file as the drift-free path, is the smallest honest version of
# that trade.
PATTERN_CONFIG="${ACTIVITY_PATTERN_CONFIG:-$STATE_DIR/stuck-patterns.txt}"

# Inbox root. ACTIVITY_INBOX_ROOT deliberately OUTRANKS INBOX_ROOT: INBOX_ROOT is
# a real ambient variable wherever this package's inbox CLI is installed, so a
# test that set only HOME would otherwise read the LIVE inboxes and pass or fail
# by who ran it.
INBOX_ROOT="${ACTIVITY_INBOX_ROOT:-${INBOX_ROOT:-$HOME/.the-vault/agents}}"

# The tmux session holding one window per agent. Same name and same default as
# bin/boot-agents.sh and bin/inbox-push use.
TMUX_SESSION="${ACTIVITY_TMUX_SESSION:-agents}"

# Windows to ignore. EMPTY BY DEFAULT: a skip list is a statement about a
# specific deployment's roster, and shipping one would silently drop somebody's
# agent from the panel for a reason found nowhere in their own configuration.
# Non-Claude runtimes render different busy markers and different dialogs, so
# this is where you exclude them if that matters to you.
SKIP_AGENTS="${ACTIVITY_SKIP_AGENTS:-}"

# WHICH CORRESPONDENTS ARE PEOPLE. Two branches of the pill cascade care:
# `needs-you` counts an unanswered card the agent sent, and `waiting-on-teammate`
# deliberately does NOT fire on a human who has not read a status note (a person
# not reading something is not a block; the blocking case with a person is a
# card, which is `needs-you`).
#
# UNSET MEANS UNRESTRICTED, NOT DISABLED, and the choice matters. Restricting to
# a configured list by default would leave a fresh install with a `needs-you`
# pill that can never fire and no error anywhere saying why -- a feature that
# looks present and is inert. So with nothing configured, an unanswered card to
# ANY correspondent counts, and no correspondent is exempt from the wait check.
# The evidence line names the correspondent either way, so an over-fire is
# visible rather than merely wrong. Configure this to narrow both branches to the
# people who actually decide things.
HUMANS="${ACTIVITY_HUMANS:-}"
is_human() {  # <correspondent> -> 0 when it is on the configured people list
  [ -n "$HUMANS" ] || return 1
  case " $HUMANS " in *" $1 "*) return 0 ;; esac
  return 1
}

TAIL_LINES="${ACTIVITY_TAIL_LINES:-20}"                # live-viewport window for literals
INBOX_TAIL_LINES="${ACTIVITY_INBOX_TAIL_LINES:-2000}"  # thread tail actually parsed
CORROB_LINES="${ACTIVITY_CORROB_LINES:-200}"           # per-thread ticket-corroboration text
RECENT_MAX="${ACTIVITY_RECENT_MAX:-5}"                 # rolling completions-log cap
RECENT_WINDOW_H="${ACTIVITY_RECENT_WINDOW_H:-48}"      # completions older than this stop entering
CARD_WINDOW_H="${ACTIVITY_CARD_WINDOW_H:-72}"          # cards older than this stop driving the pill
WAIT_MAX_MIN="${ACTIVITY_WAIT_MAX_MIN:-240}"           # unread-outbound older than this decays

# --- model-layer plumbing --------------------------------------------------------
# The sweep reads ACTIVITY_MODEL_MODE but never acts on it beyond ONE placement
# decision (see the emit block). It is deliberately the sweep's OWN variable and
# not read out of the sidecar: if the producer declared its own publication mode,
# a corrupt or hand-edited sidecar could publish itself. Two independent programs
# must agree before anything reaches a reader, which is the property that makes
# shadow mode inert.
MODEL_MODE="${ACTIVITY_MODEL_MODE:-off}"
INFERENCES_FILE="${ACTIVITY_INFERENCES_FILE:-$ACTIVITY_ROOT/inferences.json}"
MERGE_PREVIEW_FILE="${ACTIVITY_MERGE_PREVIEW_FILE:-$ACTIVITY_ROOT/merge-preview.json}"
MAX_AGE_MIN="${ACTIVITY_MAX_AGE_MIN:-360}"
# The ceiling on RETAINED prose. Past some age a sentence stops being "what they
# were doing" and becomes archaeology, so beyond it the record drops back to null
# prose and a blank panel. 360 is not a coincidence, it equals MAX_AGE_MIN:
# retained prose must never outlive the age at which a FRESH read of the same
# sentence would itself be refused, which is why the two are asserted against
# each other below rather than merely documented as equal.
STALE_PROSE_MAX_AGE_MIN="${ACTIVITY_STALE_PROSE_MAX_AGE_MIN:-360}"
CLOCK_SKEW_TOL_SEC="${ACTIVITY_CLOCK_SKEW_TOL_SEC:-120}"
# The window exists so a working agent's line stays visible between a signal
# changing and its re-inference. Inbox and git signals move on a
# minutes-to-tens-of-minutes cadence and a re-inference queue turns over in two
# or three ticks, so 30 covers the queue. The false-positive case the window buys
# (agent finished A, started B, same branch, no new signal) is small, because
# starting B almost always produces a signal: a message, or a dirty file.
# `graceHeld` is the counter that lets this be shortened later on data rather
# than on feel.
SIGNAL_GRACE_MIN="${ACTIVITY_SIGNAL_GRACE_MIN:-30}"

# --- the signals digest ----------------------------------------------------------
# Every bound here exists because a digest may be fed to a third party inside a
# byte-capped prompt, and an unbounded thread (hundreds of unread messages, huge
# subjects) must never be able to crowd the git block out of it. The whole-file
# cap is the backstop for all of them.
SIGNALS_DIR="${ACTIVITY_SIGNALS_DIR:-$ACTIVITY_ROOT/signals}"
# TRAILING SLASHES ARE STRIPPED AT ASSIGNMENT, and this is a security fix rather
# than tidiness. `[ -L "$dir" ]` is the check that refuses to write through a
# symlinked signals directory, and `[ -L "$dir/" ]` is FALSE for the very same
# symlink, because the trailing slash makes the kernel resolve it as a directory
# before the test ever sees a link. An operator who wrote
# `ACTIVITY_SIGNALS_DIR=/some/link/` would therefore have disabled the guard
# without touching it, and the sweep would have written digests straight through
# the link the guard exists to refuse. Normalised HERE, once, so every later use
# of $SIGNALS_DIR (the readiness check, the discard, the staging template) is
# testing the path itself.
# A loop rather than one `%/`, because `path//` defeats `[ -L ]` exactly as
# `path/` does; the `!= "/"` stop keeps a root-level configuration from becoming
# the empty string, which would silently re-root every digest at the working
# directory.
while [ "$SIGNALS_DIR" != "/" ] && [ "${SIGNALS_DIR%/}" != "$SIGNALS_DIR" ]; do
  SIGNALS_DIR="${SIGNALS_DIR%/}"
done
SIGNAL_PERSIST="${ACTIVITY_SIGNAL_PERSIST:-0}"
SIGNAL_MSGS_MAX="${ACTIVITY_SIGNAL_MSGS_MAX:-10}"
SIGNAL_MSG_EXCERPT="${ACTIVITY_SIGNAL_MSG_EXCERPT:-120}"
SIGNAL_SUBJECT_MAX="${ACTIVITY_SIGNAL_SUBJECT_MAX:-60}"
SIGNAL_CARDS_MAX="${ACTIVITY_SIGNAL_CARDS_MAX:-3}"
SIGNAL_DIRTY_MAX="${ACTIVITY_SIGNAL_DIRTY_MAX:-20}"
SIGNAL_COMMITS_MAX="${ACTIVITY_SIGNAL_COMMITS_MAX:-5}"
# 4800 is a DERIVED figure, not a chosen one: it is what is left of a typical
# 8,400-byte prompt cap once a ~3,300-byte instruction block is subtracted. A
# consumer should re-check that relationship at its own startup from the real
# byte count, so the next prompt edit surfaces as a warning instead of as
# permanent silent truncation. Realistic digests measure around 2,200 bytes, so
# this is a bound the common case does not come near.
SIGNAL_BYTES="${ACTIVITY_SIGNAL_BYTES:-4800}"
SIGNAL_GIT_TIMEOUT_SEC="${ACTIVITY_SIGNAL_GIT_TIMEOUT_SEC:-5}"

mkdir -p "$ACTIVITY_ROOT" "$STATE_DIR" 2>/dev/null

# --- single-instance guard -------------------------------------------------------
# A normal tick measures a few seconds against a 60-second schedule, so an
# overlap needs an order-of-magnitude slowdown. That is not the case this guards.
# `tmux capture-pane` against a WEDGED tmux server does not fail, it BLOCKS, and
# a blocked tick under a per-minute schedule is one new stacked process every
# minute, indefinitely, each holding a temp dir. Overlap also loses rolling-log
# entries: two ticks both read the prior file and the later writer wins, so
# whatever the other one appended is dropped.
#
# The lock is an fd held for the life of the process, so it CANNOT go stale: the
# kernel drops it however the holder dies, including SIGKILL. A tick that is
# skipped says so in the health file, and activity.json goes visibly stale for
# every reader's own staleness banner, so silent-and-piling-up becomes
# loud-and-idle. Without flock the behaviour is exactly as it would otherwise
# be: this is an addition, never a new hard dependency.
LOCK_FILE="$ACTIVITY_ROOT/.sweep.lock"
if command -v flock >/dev/null 2>&1 && (: > "$LOCK_FILE") 2>/dev/null; then
  # The subshell above is what proves the open cannot fail, and it is a subshell
  # ON PURPOSE: `exec 9>"$LOCK_FILE" 2>/dev/null` would make that stderr
  # redirection PERMANENT for the rest of the script, silencing every later
  # diagnostic. `exec` redirections apply to the shell, not to one command.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf '{"swept":"%s","verdict":"skipped","error":"previous-run-still-running"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE" 2>/dev/null
    exit 0
  fi
fi

# --- hard dependency: jq ---------------------------------------------------------
# Every string this sweep emits is adversarially shaped by accident: commit
# subjects, card ids and inbox prose routinely contain quotes, backslashes and
# unicode. Hand-printed JSON with the offending characters stripped is fine for a
# fixed-shape state file and NOT fine for a file whose whole job is carrying
# human text to two other consumers. `jq --arg` is the only escaping that is
# actually correct here, so no-jq refuses the tick rather than writing a file
# that parses today and breaks on the first apostrophe.
if ! command -v jq >/dev/null 2>&1; then
  echo "$SELF: jq not found on PATH; refusing to write activity.json" >&2
  printf '{"swept":"%s","verdict":"error","error":"no-jq"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE" 2>/dev/null
  exit 0
fi

# --- fail-closed helper ----------------------------------------------------------
# Same degrade as every other refusal in this script: leave the previous
# activity.json alone, record a DISTINCT reason, exit 0 so a scheduler does not
# mail about it.
fail_closed() {  # <error-string> [<detail>]
  echo "$SELF: $1${2:+ ($2)}; leaving the previous $ACTIVITY_FILE untouched" >&2
  printf '{"swept":"%s","verdict":"error","error":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$STATE_FILE" 2>/dev/null
  exit 0
}

# --- staleness-constant startup assertions ---------------------------------------
# The freshness contract is arithmetic, and a configuration edit is the one thing
# that can void it silently. These cost a line each and make the invariant
# non-bypassable by config rather than merely documented.
#
# The last clause is conditional ON PURPOSE. `SIGNAL_GRACE_MIN = 0` is a
# supported configuration meaning "no signal tolerance at all" (it reverts to the
# literal single-hash contract), and the invariant being protected -- that a
# within-tolerance future-dated record cannot sit inside a grace window wider
# than the tolerance itself -- is vacuous when there is no window. The
# unconditional form is unsatisfiable at zero grace and would fail the whole
# sweep closed.
case "$MODEL_MODE" in off|shadow|live) ;; *) fail_closed "bad-model-mode" "$MODEL_MODE" ;; esac
for _c in MAX_AGE_MIN STALE_PROSE_MAX_AGE_MIN SIGNAL_GRACE_MIN CLOCK_SKEW_TOL_SEC; do
  case "${!_c}" in
    ''|*[!0-9]*) fail_closed "bad-staleness-constant" "$_c=${!_c}" ;;
  esac
done
# The digest bounds get the same treatment for the same reason: each one is fed
# straight to `head -n`, `cut -c` or a byte comparison, where a non-numeric value
# is either a silent no-op bound or a hard error mid-tick. A bound that does not
# bind is worse than no bound, because it looks like one.
for _c in SIGNAL_MSGS_MAX SIGNAL_MSG_EXCERPT SIGNAL_SUBJECT_MAX SIGNAL_CARDS_MAX \
          SIGNAL_DIRTY_MAX SIGNAL_COMMITS_MAX SIGNAL_BYTES SIGNAL_GIT_TIMEOUT_SEC; do
  case "${!_c}" in
    ''|*[!0-9]*) fail_closed "bad-signal-constant" "$_c=${!_c}" ;;
  esac
done
SIGNAL_MSGS_MAX=$((10#$SIGNAL_MSGS_MAX)); SIGNAL_MSG_EXCERPT=$((10#$SIGNAL_MSG_EXCERPT))
SIGNAL_SUBJECT_MAX=$((10#$SIGNAL_SUBJECT_MAX)); SIGNAL_CARDS_MAX=$((10#$SIGNAL_CARDS_MAX))
SIGNAL_DIRTY_MAX=$((10#$SIGNAL_DIRTY_MAX)); SIGNAL_COMMITS_MAX=$((10#$SIGNAL_COMMITS_MAX))
SIGNAL_BYTES=$((10#$SIGNAL_BYTES)); SIGNAL_GIT_TIMEOUT_SEC=$((10#$SIGNAL_GIT_TIMEOUT_SEC))
[ "$SIGNAL_BYTES" -gt 0 ] || fail_closed "bad-signal-constant" "SIGNAL_BYTES is zero"
# 10# on every one: bash's $(( )) octal-parses a leading zero while [ ] does not,
# so an `08` reaching an arithmetic comparison silently changes it.
MAX_AGE_MIN=$((10#$MAX_AGE_MIN)); SIGNAL_GRACE_MIN=$((10#$SIGNAL_GRACE_MIN))
STALE_PROSE_MAX_AGE_MIN=$((10#$STALE_PROSE_MAX_AGE_MIN))
CLOCK_SKEW_TOL_SEC=$((10#$CLOCK_SKEW_TOL_SEC))
MAX_AGE_SEC=$(( MAX_AGE_MIN * 60 )); SIGNAL_GRACE_SEC=$(( SIGNAL_GRACE_MIN * 60 ))
STALE_PROSE_MAX_AGE_SEC=$(( STALE_PROSE_MAX_AGE_MIN * 60 ))
[ "$CLOCK_SKEW_TOL_SEC" -lt "$MAX_AGE_SEC" ] \
  || fail_closed "bad-staleness-constant" "skew-tolerance >= max-age"
# Retained prose must not outlive the age at which fresh prose would be refused.
# A ceiling above MAX_AGE would keep publishing a sentence the `too-old` clause
# has already declared unfit, which is the one way this could quietly become the
# thing it was designed not to be.
[ "$STALE_PROSE_MAX_AGE_SEC" -le "$MAX_AGE_SEC" ] \
  || fail_closed "bad-staleness-constant" "stale-prose-ceiling > max-age"
if [ "$SIGNAL_GRACE_MIN" -ne 0 ] && [ "$CLOCK_SKEW_TOL_SEC" -ge "$SIGNAL_GRACE_SEC" ]; then
  fail_closed "bad-staleness-constant" "skew-tolerance >= signal-grace"
fi

# --- shared busy/idle classification (bin/pane-idle) -----------------------------
# Sourced, never re-implemented. This is the same library inbox-push and
# stuck-pane-sweep.sh source; using it is the "one busy/idle definition" rule,
# and it is NOT the pane-capture coupling the observer/actuator split forbids.
# BASH_SOURCE-relative so a checkout tests itself; the AGENTS_HOME fallback is
# for an installed copy invoked from elsewhere.
AGENTS_HOME="${AGENTS_HOME:-$HOME/agents}"
PANE_IDLE_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/pane-idle"
[ -r "$PANE_IDLE_LIB" ] || PANE_IDLE_LIB="$AGENTS_HOME/bin/pane-idle"
# shellcheck source=./pane-idle
. "$PANE_IDLE_LIB" 2>/dev/null
# Presence, not a minimum version: this sweep uses check_idle and nothing else,
# and check_idle has been in the library since v1. The composer primitives it
# does NOT use are what stuck-pane-sweep.sh pins a minimum for.
if [ -z "${PANE_IDLE_LIB_VERSION:-}" ]; then
  echo "$SELF: cannot source pane-idle lib ($PANE_IDLE_LIB)" >&2
  printf '{"swept":"%s","verdict":"error","error":"no-pane-idle-lib"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE" 2>/dev/null
  exit 0
fi

# --- clock -----------------------------------------------------------------------
# Read once, reused everywhere, and overridable so a test pins an exact instant
# rather than racing the wall clock. All timestamps are fixed-width ISO-8601 UTC,
# which is what lets every age comparison below be a STRING comparison against a
# precomputed cutoff: no `date -d` fork per record, and no timezone to get wrong.
#
# DOUBLE-KEYED against ACTIVITY_FIXTURE_DIR. This clock is the input to a
# freshness verdict, so a stray ACTIVITY_NOW_EPOCH inherited from a scheduler's
# environment would not just mislabel a timestamp, it would move the staleness
# window for every agent at once. A test that wants a frozen clock is already in
# fixture mode; a live run has no legitimate reason to be told what time it is.
if { [ -n "${ACTIVITY_NOW:-}" ] || [ -n "${ACTIVITY_NOW_EPOCH:-}" ]; } \
   && [ -n "${ACTIVITY_FIXTURE_DIR:-}" ]; then
  NOW="${ACTIVITY_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  NOW_EPOCH="${ACTIVITY_NOW_EPOCH:-$(date +%s)}"
else
  read -r NOW NOW_EPOCH < <(date -u +'%Y-%m-%dT%H:%M:%SZ %s')
fi
iso_ago() {  # <seconds-ago> -> ISO cutoff string
  date -u -d "@$(( NOW_EPOCH - $1 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -r "$(( NOW_EPOCH - $1 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}
CARD_CUTOFF=$(iso_ago $(( CARD_WINDOW_H * 3600 )))
RECENT_CUTOFF=$(iso_ago $(( RECENT_WINDOW_H * 3600 )))
WAIT_CUTOFF=$(iso_ago $(( WAIT_MAX_MIN * 60 )))

# --- pane capture (its own capture, per the observer/actuator split) --------------
capture_pane() {
  local w="$1"
  if [ -n "${ACTIVITY_FIXTURE_DIR:-}" ]; then
    cat "$ACTIVITY_FIXTURE_DIR/$w.txt" 2>/dev/null
  else
    tmux capture-pane -t "${TMUX_SESSION}:${w}" -p 2>/dev/null
  fi
}

# Same normalisation as the sibling sweep: a resting pane still repaints its own
# padding, so an un-normalised hash never repeats and "unchanged since" never
# advances.
pane_hash() {
  printf '%s\n' "$1" | sed -e 's/[[:space:]]*$//' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' \
    | sha256sum 2>/dev/null | cut -c1-16
}

# How many sub-agents an agent is running. Nothing in the inbox or git signals can
# see this; it exists only in the pane's live UI region.
#
# CALIBRATED AGAINST CLAUDE CODE, and against nothing else. A runtime that does
# not draw this region produces no match and no count, which is the correct
# answer for it (see the empty-vs-zero split below), not a degraded one.
#
# WHAT THIS DOES *NOT* READ, and the trap it is easy to fall into: the
# "<- N agents" hint in the auto-mode line is the agent SWITCHER, not a count of
# running sub-agents. It is present on EVERY Claude pane including completely
# idle ones and reads `1` regardless. Measured over 754 samples of 13 live panes,
# including twelve transitions where the real count went 2->1 and 1->0, the hint
# never moved off 1. Keying this on it would have detected every agent, always.
#
# WHAT IT DOES READ: the per-agent ROWS below that line, each marked with U+25EF.
# Two properties earn the anchor:
#   - the region below the auto-mode line is drawn by the live UI and nothing
#     else, so transcript text cannot reach it and the glyph never appears above
#     it (checked against every capture taken). The switcher hint is therefore
#     the right thing to anchor the REGION on even though its number is the wrong
#     thing to read.
#   - a FINISHED sub-agent leaves the list entirely, so this counts RUNNING
#     agents, not switcher entries.
#
# It counts the glyph and NOT the trailing token counter, deliberately: a
# sub-agent that has been spawned but not yet started renders with no timer and
# no counter, and it is running under the agent as much as any other. Requiring
# the counter would silently undercount exactly at the moment work is handed out.
#
# Bounds worth knowing: the list is drawn inside the pane, so a pane short enough
# to clip it undercounts, and this is a floor rather than a certainty. That is
# the same bound every other pane-derived signal here already carries.
#
# KNOWN SPOOF, accepted, and stated rather than implied away. "Transcript text
# cannot reach it" above is only true on a pane WITH a live UI region. On a
# foreign pane (no switcher line of its own), a pasted capture containing both
# the anchor and the glyph rows in its transcript IS mistaken for the live
# region -- for instance, printing this very comment block into such a pane.
#
# Get the failure direction right. The count is not display-only: it drives
# `status`, and `status` is in bundleHash, so a spoof can mislabel the pill and
# move the bundle hash. A foreign pane spoofed into `waiting-on-machine`
# outranks the card check the same way a real subagent count does, so a real open
# card is masked for as long as the spoofed text sits in the idle pane's tail.
# It is accepted anyway because this masking class is not new: pasted busy-shaped
# text ("esc to interrupt", a trailing "(16s)") has always been able to mask
# `needs-you` as `working` through the same pane-outranks-inbox precedence, with
# the same persistence. This adds one more spoofable shape to an existing
# accepted class, not a new class. The only real fix (skip non-Claude panes
# entirely) needs a runtime check this script does not otherwise make; revisit if
# it ever proves noisy in practice.
parse_subagent_count() {  # <pane-text> -> count on stdout; rc 1 when there is no live UI region
  printf '%s\n' "$1" | awk '
    /←[ \t]*[0-9]+[ \t]*agents?([ \t]|$)/ { seen = 1; n = 0; next }
    seen && /^[ \t]*◯[ \t]/ { n++ }
    END { if (!seen) exit 1; print n }
  '
}

# --- the capture boundary --------------------------------------------------------
# Redaction is applied ONCE, at this boundary, before EITHER sink: disk or
# network. Ordering is load-bearing: strip control bytes, bound by LINES, redact,
# and only then bound by BYTES. Byte-capping before redacting could cut a
# credential in half and leave a fragment that no longer matches the pattern that
# would have caught it.
#
# HONEST RESIDUAL, stated rather than implied away: this redacts credential-SHAPED
# strings. Personal data and repository content in a message are NOT redacted and
# do reach disk (0600) and, if you wire up a consumer, a provider (bounded).
# Decide whether that is acceptable for your deployment before turning
# ACTIVITY_SIGNAL_PERSIST on; it is why the default here is off.
REDACT_SED='
/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\
[REDACTED-PRIVATE-KEY]
s/\bsk-[A-Za-z0-9_-]{16,}/[REDACTED-KEY]/g
s/\bAIza[A-Za-z0-9_-]{20,}/[REDACTED-KEY]/g
s/\bgh[pousr]_[A-Za-z0-9]{16,}/[REDACTED-TOKEN]/g
s/\bglpat-[A-Za-z0-9_-]{16,}/[REDACTED-TOKEN]/g
s/\bxox[baprs]-[A-Za-z0-9-]{10,}/[REDACTED-TOKEN]/g
s/\bAKIA[0-9A-Z]{16}\b/[REDACTED-TOKEN]/g
s/[Bb]earer[[:space:]]+[A-Za-z0-9._~+\/=-]{16,}/Bearer [REDACTED-TOKEN]/g
s/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/[REDACTED-JWT]/g
s/(([A-Za-z0-9_-]*[Aa][Pp][Ii][_-]?)?([Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww]?[Oo]?[Rr]?[Dd]))([[:space:]]*[=:][[:space:]]*)("?)[^"[:space:]]{6,}\5/\1\4[REDACTED]/g
'
# The seam is honoured ONLY in fixture mode. A redactor that can be replaced from
# the environment on a live run is not a redactor; the double key is the same
# reasoning as the clock override above.
redact_text() {  # text on stdin -> redacted text on stdout; NON-ZERO means "drop it"
  if [ -n "${ACTIVITY_FIXTURE_DIR:-}" ] && [ -n "${ACTIVITY_REDACT_CMD:-}" ]; then
    $ACTIVITY_REDACT_CMD
    return $?
  fi
  sed -E "$REDACT_SED"
}

# ANSI/control strip + ASCII-only. Terminal output is full of escape sequences
# and box-drawing characters; neither survives an ASCII-only prompt rule, and
# both would otherwise be counted against the byte cap.
pane_scrub() {  # text on stdin -> printable-ASCII lines on stdout
  # LC_ALL=C IS LOAD-BEARING, not tidiness, and it was MEASURED rather than
  # reasoned about. `[^\x20-\x7e]` is a character class, and under a UTF-8 locale
  # sed matches CHARACTERS: a byte sequence that is not valid UTF-8 is not a
  # character it can match, so invalid bytes pass straight through the scrub
  # untouched. Everything downstream is written as if they could not:
  # `signal_digest_text` compares a CHARACTER count against a BYTE cap and says
  # in its own comment that the two agree "because pane_scrub has already run".
  # Valid multibyte sed does handle; invalid bytes were the case neither could
  # see. In C the class is a byte range and the guarantee is unconditional.
  LC_ALL=C sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b\][^\x07]*\x07//g' -e 's/\x1b[()][A-Za-z0-9]//g' \
      -e 's/\r//g' -e 's/\t/ /g' -e 's/[^\x20-\x7e]/ /g' -e 's/[[:space:]]*$//'
}

SIGNAL_DIR_OK=-1
signals_dir_ready() {
  [ "$SIGNAL_DIR_OK" = "-1" ] || return "$SIGNAL_DIR_OK"
  SIGNAL_DIR_OK=1
  if [ -L "$SIGNALS_DIR" ]; then
    notes+=("signals persistence refused: $SIGNALS_DIR is a symlink"); return 1
  fi
  mkdir -p "$SIGNALS_DIR" 2>/dev/null || { notes+=("signals persistence refused: cannot create $SIGNALS_DIR"); return 1; }
  if [ ! -O "$SIGNALS_DIR" ]; then
    notes+=("signals persistence refused: $SIGNALS_DIR is not owned by this user"); return 1
  fi
  chmod 700 "$SIGNALS_DIR" 2>/dev/null
  SIGNAL_DIR_OK=0; return 0
}

# Scrub -> redact -> byte-cap, in that order and for the reason given at the
# capture boundary above. The per-section LINE bounds are applied during assembly
# (each list is built already-capped), so this is the whole-file backstop.
signal_digest_text() {  # <digest text> -> scrubbed+redacted+bounded, or non-zero
  # NO LOCALE PIN NEEDED HERE, and the reason is a real invariant rather than
  # luck. `${#redacted}` counts CHARACTERS while the `head -c` below counts
  # BYTES, which would under-enforce the cap on multibyte text -- except that
  # `pane_scrub` has already run and maps every byte outside \x20-\x7e to a
  # space, so what reaches this comparison is printable ASCII and the two units
  # are the same number. A consumer that re-bounds a file written by an
  # independently-shipped producer cannot assume this scrub ran and SHOULD pin
  # its own locale.
  local scrubbed redacted
  scrubbed=$(printf '%s\n' "$1" | pane_scrub 2>/dev/null) || return 1
  redacted=$(printf '%s\n' "$scrubbed" | redact_text 2>/dev/null) || return 1
  [ -n "$scrubbed" ] && [ -z "$redacted" ] && return 1
  # Byte cap keeps the HEAD, deliberately: the summary lines (unread, open cards,
  # waiting-on) sit at the top and are both the smallest and the most "now". Drop
  # the possibly-half LAST line so a reader never takes a truncated fragment as a
  # fact.
  if [ "${#redacted}" -gt "$SIGNAL_BYTES" ]; then
    redacted=$(printf '%s' "$redacted" | head -c "$SIGNAL_BYTES" | sed -e '$d')
  fi
  printf '%s\n' "$redacted"
}

# THE AGENT NAME IS INPUT, and every path in this section is built by
# CONCATENATION. The name reaching `discard_stale_digest` and
# `persist_signals_digest` comes from `tmux list-windows`, and anything on the
# box can call `tmux rename-window`. `"$SIGNALS_DIR/$1.txt"` for a window named
# `../../precious` addresses a file two levels ABOVE the signals directory, and
# the discard really did `rm -f` it. The write half is the same construction:
# with the matching path components present, `mv -f` installed a 0600 digest
# outside the directory too.
#
# EVERY OTHER GUARD IN THIS SECTION PASSED WHILE THAT HAPPENED, which is the part
# worth remembering. They check the DIRECTORY (not a symlink, exists, owned by
# this user) and the RESOLVED TARGET (not a symlink, is a regular file), both
# entirely true of a file somewhere else on the disk. No test of the resolved
# path can recover this, because `$SIGNALS_DIR/../precious.txt` is
# indistinguishable from a legitimate path to a file genuinely called
# `../precious.txt`. The information exists only in the NAME, before
# concatenation, so that is where it is checked and why this runs first in both
# functions.
#
# Refused:
#   - any `/`, ANYWHERE in the name. `*/*` covers a LEADING slash as well, and it
#     is deliberately not a special case: `/etc/passwd` concatenates to
#     `$SIGNALS_DIR//etc/passwd.txt`, which does NOT escape (the directory is
#     always the prefix) but does address a subtree this system neither creates
#     nor manages.
#   - a LEADING dot, which is `.` and `..` themselves, and also the `.<name>.txt.`
#     staging namespace `persist_signals_digest` uses for its own temp files.
#   - the empty string, which would make the target the directory's own `.txt`.
#     The sweep loop already skips an empty window name, so this is the helper
#     refusing to depend on a caller's guard rather than a reachable case.
# Nothing else is refused: a real agent name is a plain filename component, and a
# broader charset rule would refuse live agents to buy nothing.
safe_agent_filename() {  # <agent> -> 0 if it is safe to use as one path component
  case "$1" in
    ''|.*|*/*) return 1 ;;
  esac
  return 0
}

# Drop THIS SYSTEM'S OWN digest for one agent. Called on every refresh that did
# not land: a digest that was not refreshed this tick is not this tick's digest,
# and a reader has no way to tell the difference. Leaving an old file in place is
# what lets a stale digest be read while the record advertises the hash of a
# digest that never reached disk -- a failure presented as a success.
#
# DELIBERATELY NARROW, so that a refusal never becomes a deletion: it removes a
# REGULAR file, not a symlink and not a directory, and only from a directory that
# exists, is not itself a symlink, and is owned by this user. Every path this
# system has already declined to write to is therefore also a path it declines to
# delete from.
discard_stale_digest() {  # <agent>
  # FIRST, before a path is built at all: a name that is not a plain component
  # does not address this system's own digest, whatever the checks below then say
  # about where it points. Returns 0, the same "nothing of ours to drop" answer
  # every other refusal here gives, so a refusal still never becomes a deletion.
  safe_agent_filename "$1" || return 0
  local target="$SIGNALS_DIR/$1.txt"
  [ -L "$SIGNALS_DIR" ] && return 0
  [ -d "$SIGNALS_DIR" ] || return 0
  [ -O "$SIGNALS_DIR" ] || return 0
  [ -L "$target" ] && return 0
  [ -f "$target" ] || return 0
  # BEST EFFORT, AND THAT IS A DECISION RATHER THAN A GAP. The `rm -f` can fail
  # (read-only mount, immutable file, a mode this user cannot chmod back) and
  # this still returns 0. What makes best-effort genuinely fine is the rule on
  # the reader's side: a consumer takes a digest only when the record carries a
  # signalHash AND the bytes hash to it, so a digest this function failed to
  # remove is refused there. Not moved here on purpose: a cleanup that reported
  # its own failure would still leave the file, and the reader has to hold that
  # line for the ownership refusal above regardless, where declining to delete is
  # CORRECT and there is nothing to report at all.
  rm -f "$target" 2>/dev/null
  return 0
}

# 0 = the text handed in is now THE digest on disk, and its hash may be
# published. Non-zero = it is not, and no stale digest of this system's own is
# left behind for a reader to mistake for it. The return value is load-bearing;
# the caller must not publish a signalHash it cannot back with a readable digest.
persist_signals_digest() {  # <agent> <digest text, already scrubbed+redacted>
  local w="$1" target tmp
  # Same guard, same reason, and BEFORE the discard: this name never addressed a
  # digest of this system's, so there is nothing here to write and nothing to
  # drop. Non-zero, because from the caller's side this is a digest that did not
  # land and its hash must not be published. Recorded rather than silent: a
  # window renamed into this shape is an operator error at best, and the state
  # file is where it becomes visible.
  if ! safe_agent_filename "$w"; then
    notes+=("signals digest refused for $w: not a plain agent name")
    return 1
  fi
  target="$SIGNALS_DIR/$w.txt"
  # Persistence off is a CONFIGURATION, not a fault, and it still has to mean the
  # corpus does not exist rather than that an older copy is frozen in place.
  if [ "$SIGNAL_PERSIST" != "1" ] || [ -z "$2" ]; then
    discard_stale_digest "$w"; return 1
  fi
  if ! signals_dir_ready; then discard_stale_digest "$w"; return 1; fi
  # The one NON-DESTRUCTIVE branch, and it stays that way on purpose: this is a
  # path this system does not manage, so it neither writes to it nor removes it.
  # A conforming consumer refuses to read a symlink or a non-regular file too, so
  # nothing here is readable as a current digest either.
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    notes+=("signals digest refused for $w: target is not a regular file")
    return 1
  fi
  if ! tmp=$(mktemp "$SIGNALS_DIR/.$w.txt.XXXXXX" 2>/dev/null); then
    notes+=("signals digest not refreshed for $w: no temporary file")
    discard_stale_digest "$w"; return 1
  fi
  chmod 600 "$tmp" 2>/dev/null
  if printf '%s' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$target" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  notes+=("signals digest not refreshed for $w: write failed")
  discard_stale_digest "$w"
  return 1
}

# --- timestamp validation --------------------------------------------------------
# Pure arithmetic, no `date` fork and no timezone: this runs twice per agent per
# tick and feeds a verdict, so it must be deterministic and cheap. Accepts
# RFC3339 Z or an integer epoch, and REJECTS everything else rather than guessing.
parse_epoch() {  # <value> -> epoch seconds on stdout; non-zero if unparseable
  local v="$1" y mo d h mi s yy era yoe doy doe days
  case "$v" in ''|null) return 1 ;; esac
  if [[ "$v" =~ ^-[0-9]+$ ]]; then printf '%s' "$(( -1 * 10#${v#-} ))"; return 0; fi
  if [[ "$v" =~ ^[0-9]+$ ]];   then printf '%s' "$((10#$v))";           return 0; fi
  [[ "$v" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$ ]] || return 1
  # 10# on every field: `08` is not octal here, and $(( )) would say otherwise.
  y=$((10#${BASH_REMATCH[1]})); mo=$((10#${BASH_REMATCH[2]})); d=$((10#${BASH_REMATCH[3]}))
  h=$((10#${BASH_REMATCH[4]})); mi=$((10#${BASH_REMATCH[5]})); s=$((10#${BASH_REMATCH[6]}))
  [ "$mo" -ge 1 ] && [ "$mo" -le 12 ] && [ "$d" -ge 1 ] && [ "$d" -le 31 ] \
    && [ "$h" -le 23 ] && [ "$mi" -le 59 ] && [ "$s" -le 60 ] || return 1
  if [ "$mo" -le 2 ]; then yy=$(( y - 1 )); else yy=$y; fi
  if [ "$yy" -ge 0 ]; then era=$(( yy / 400 )); else era=$(( (yy - 399) / 400 )); fi
  yoe=$(( yy - era * 400 ))
  if [ "$mo" -gt 2 ]; then doy=$(( (153 * (mo - 3) + 2) / 5 + d - 1 ))
  else doy=$(( (153 * (mo + 9) + 2) / 5 + d - 1 )); fi
  doe=$(( yoe * 365 + yoe/4 - yoe/100 + doy ))
  days=$(( era * 146097 + doe - 719468 ))
  printf '%s' "$(( days * 86400 + h * 3600 + mi * 60 + s ))"
}
EPOCH_FLOOR=1735689600   # 2025-01-01Z -- rejects epoch 0 and pre-project garbage

# --- stuck-shape literals --------------------------------------------------------
load_patterns() {
  if [ -f "$PATTERN_CONFIG" ]; then
    grep -v '^[[:space:]]*#' "$PATTERN_CONFIG" 2>/dev/null | grep -v '^[[:space:]]*$'
  else
    echo "Auto mode classifier requires confirmation"
  fi
}
# Matched in the live TAIL only, same reason as the sibling sweep: a dialog
# already dealt with, or an agent whose pane is literally discussing this
# feature, sits higher in the viewport and must not read as a live wedge.
match_pattern() {
  local pane="$1" tail_txt p
  tail_txt=$(printf '%s\n' "$pane" | tail -n "$TAIL_LINES")
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if printf '%s\n' "$tail_txt" | grep -qF -- "$p" 2>/dev/null; then
      printf '%s\n' "$p"; return 0
    fi
  done <<EOF
$(load_patterns)
EOF
  return 1
}

# --- worktree roots config -------------------------------------------------------
# One glob per line, `#` comments, $HOME and ~ expanded. The built-in default is
# a guess at a common layout and nothing more: point ACTIVITY_ROOTS_CONFIG at a
# file listing where YOUR repositories and worktrees actually live.
#
# ROOTS_SOURCE is resolved HERE and not inside load_roots(): load_roots is called
# from a command substitution, which is a subshell, so an assignment made in it
# is discarded. The provenance would then have reported "builtin" on every run
# regardless of the config actually in use -- a state file quietly lying about
# where its own inputs came from.
ROOTS_SOURCE="builtin"; [ -f "$ROOTS_CONFIG" ] && ROOTS_SOURCE="config"
load_roots() {
  if [ -f "$ROOTS_CONFIG" ]; then
    grep -v '^[[:space:]]*#' "$ROOTS_CONFIG" 2>/dev/null | grep -v '^[[:space:]]*$'
  else
    printf '%s\n' '$HOME/repos/*' '$HOME/projects/*' '$HOME/worktrees/*'
  fi
}

# --- candidate table -------------------------------------------------------------
# Built ONCE per tick and scored per agent, not rebuilt once per agent.
#
# The branch is read from .git/HEAD as a FILE, never via `git branch
# --show-current`. There can be hundreds of candidate directories; a git fork
# each, every 60 seconds, is a real cost for a value sitting in a two-line text
# file. Handles both shapes: .git as a directory (clone) and .git as a `gitdir:`
# pointer file (linked worktree, which most of these usually are).
WT_PATHS=(); WT_BRANCHES=(); WT_MTIMES=()
build_candidates() {
  local line d gitdir headfile idxfile head branch ts name i im hm best
  local -a dirs=() metafiles=()
  local -A mt=()
  local IFS=$'\n'
  for line in $(load_roots); do
    line=${line//\$HOME/$HOME}
    line=${line/#\~/$HOME}
    # Unquoted on purpose: this is the pathname expansion. IFS stays newline-only
    # so a pattern is never split mid-path; glob RESULTS are separate words
    # regardless of IFS, so the expansion still works.
    for d in $line; do
      [ -d "$d" ] || continue
      [ -e "$d/.git" ] || continue
      dirs+=("$d")
    done
  done
  [ "${#dirs[@]}" -gt 0 ] || return 0

  for d in "${dirs[@]}"; do
    gitdir=""
    if [ -d "$d/.git" ]; then
      gitdir="$d/.git"
    elif [ -f "$d/.git" ]; then
      gitdir=$(sed -n 's/^gitdir:[[:space:]]*//p' "$d/.git" 2>/dev/null | head -1)
      case "$gitdir" in /*) ;; *) gitdir="$d/$gitdir" ;; esac
    fi
    [ -n "$gitdir" ] && [ -r "$gitdir/HEAD" ] || continue
    head=$(head -1 "$gitdir/HEAD" 2>/dev/null)
    case "$head" in
      "ref: refs/heads/"*) branch="${head#ref: refs/heads/}" ;;
      "")                  branch="" ;;
      *)                   branch="detached:${head:0:8}" ;;
    esac
    [ -n "$branch" ] || continue
    WT_PATHS+=("$d"); WT_BRANCHES+=("$branch")
    idxfile="$gitdir/index"; [ -e "$idxfile" ] || idxfile="$gitdir/HEAD"
    metafiles+=("$idxfile") ; metafiles+=("$gitdir/HEAD")
  done
  [ "${#WT_PATHS[@]}" -gt 0 ] || return 0

  # ONE stat call for every mtime, not one per directory. Recency is a named
  # tie-break so it is read for every candidate, and hundreds of stat forks a
  # minute is the difference between a free sweep and a noticeable one.
  # IFS is newline-only for this whole function (the glob loop above needs it),
  # so this read MUST re-specify a space separator. Without it the whole line
  # lands in $ts, $name is empty, every mtime silently reads as 0, and the
  # recency signal AND its tie-break both vanish while the sweep still looks
  # healthy.
  while IFS=' ' read -r ts name; do
    [ -n "$name" ] && mt["$name"]="$ts"
  done < <(stat -c '%Y %n' "${metafiles[@]}" 2>/dev/null)

  i=0
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    im="${mt[${metafiles[$((i*2))]}]:-0}"
    hm="${mt[${metafiles[$((i*2+1))]}]:-0}"
    best="$im"
    if [ "$hm" -gt "$best" ] 2>/dev/null; then best="$hm"; fi
    WT_MTIMES+=("$best")
    i=$((i+1))
  done
}

# --- worktree scorer -------------------------------------------------------------
# No single reliable signal exists: a pane's cwd is useless (an agent typically
# works via `git -C` from its own home) and git authorship is useless (in a
# single-operator deployment everything commits as the same person). So this is a
# weighted score over four independent weak signals, and the CONFIDENCE emitted
# alongside is the actual product. With a large collection of mostly-stale
# worktrees the design goal is "wrong cheaply and visibly", never "never wrong".
#
#   +50  branch prefix `<agent>/...`      the strongest signal
#   +30  worktree name `[*-]<agent>[N]`   the next
#   +15  a ticket id in the branch also appears in that agent's own recent inbox
#        or observation text -- the corroboration signal, and the only one of the
#        four sourced from outside the filesystem layout
#   +12/+8/+4/+1  activity within 15m / 1h / 6h / 24h (git index or HEAD mtime)
#
# TIE-BREAKS are a TOTAL ORDER, so identical inputs always give an identical
# answer and a wobbling chip can never be mistaken for real movement:
#   1. score, descending
#   2. most recent index/HEAD mtime, descending   (the recency tie-break)
#   3. path, ascending, LC_ALL=C                  (final; makes it deterministic)
# Recency appears twice on purpose: coarsely in the score, exactly in the
# tie-break. The buckets are what let a fresh-but-unnamed tree beat a stale
# perfectly-named one; the exact mtime is what separates two trees that landed in
# the same bucket, which is the common case among one agent's own worktrees.
#
# Emits sorted candidate lines: score \t mtime \t path \t branch \t reasons
score_worktrees() {
  local agent="$1" recent_text="$2"
  local i=0 path branch mtime base score reasons ticket age
  local out=""
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    path="${WT_PATHS[$i]}"; branch="${WT_BRANCHES[$i]}"; mtime="${WT_MTIMES[$i]}"
    i=$((i+1))
    base="${path##*/}"
    score=0; reasons=""

    case "$branch" in
      "$agent"/*) score=$((score+50)); reasons="${reasons}branch-prefix=$agent/;" ;;
    esac
    if [[ "$base" =~ (^|-)"$agent"[0-9]*$ ]]; then
      score=$((score+30)); reasons="${reasons}worktree-name=$base;"
    fi
    # Corroboration only strengthens a tree already plausible on some other
    # signal. Unconditional, a ticket everyone is discussing would pull every
    # unrelated tree mentioning it into the running -- noise dressed as evidence.
    if [ "$score" -gt 0 ] && [ -s "$recent_text" ]; then
      ticket=$(printf '%s\n' "$branch" | grep -oiE '[a-z]{2,5}-[0-9]{2,5}' | head -1)
      if [ -n "$ticket" ] && grep -qiF -- "$ticket" "$recent_text" 2>/dev/null; then
        score=$((score+15)); reasons="${reasons}ticket=$ticket;"
      fi
    fi
    if [ "$score" -gt 0 ] && [ "${mtime:-0}" -gt 0 ] 2>/dev/null; then
      age=$(( NOW_EPOCH - mtime ))
      if   [ "$age" -lt 900 ];   then score=$((score+12)); reasons="${reasons}active<15m;"
      elif [ "$age" -lt 3600 ];  then score=$((score+8));  reasons="${reasons}active<1h;"
      elif [ "$age" -lt 21600 ]; then score=$((score+4));  reasons="${reasons}active<6h;"
      elif [ "$age" -lt 86400 ]; then score=$((score+1));  reasons="${reasons}active<24h;"
      fi
    fi
    [ "$score" -gt 0 ] || continue
    out="${out}${score}	${mtime}	${path}	${branch}	${reasons%;}
"
  done
  [ -n "$out" ] || return 0
  printf '%s' "$out" | LC_ALL=C sort -t'	' -k1,1nr -k2,2nr -k3,3
}

# Confidence from the top two scores. A lone strong candidate is high; two close
# candidates are NOT, however strong the leader -- the whole point is that the
# chip says "I am guessing" exactly when it is guessing.
confidence_for() {  # <top> <runner-up>
  local top="$1" second="${2:-0}" margin
  margin=$(( top - second ))
  if   [ "$top" -ge 50 ] && [ "$margin" -ge 15 ]; then echo high
  elif [ "$top" -ge 30 ] && [ "$margin" -ge 10 ]; then echo medium
  else echo low
  fi
}

# --- inbox scan ------------------------------------------------------------------
# One awk pass per thread file, emitting TSV records. Parses the block format
# specified in docs/protocol.md: a `## <ts> - from: X - status: Y - subject: Z`
# header, an optional metadata region up to the first blank line, then the body.
#
# Ages are compared as STRINGS against cutoffs computed once in bash. Fixed-width
# ISO-8601 UTC sorts chronologically, so this needs no date parsing in awk (no
# gawk-only mktime, no fork per record) and cannot acquire a timezone bug.
#
# Records:
#   CARD <ts> <kind> <id> <open> <subject>
#                                  a card the AGENT sent (0/1 = resolved/open).
#                                  The subject is carried for the signals digest,
#                                  so a consumer can say what the card is ABOUT
#                                  rather than only that one exists.
#   DONE <ts> <label>              an AGENT message whose FIRST body line reads
#                                  as a completion
#   LAST <ts> <sender> <status> <wasCompletion>
#                                  the final block in the thread (wait
#                                  detection). wasCompletion is carried because a
#                                  sign-off is not a wait; see the LAST handler.
#   MSG  <ts> <sender> <status> <subject> <excerpt>
#                                  the newest MSGS_MAX blocks in this thread,
#                                  BOTH directions. This is the richest signal
#                                  the digest carries: what the agent said it was
#                                  doing and what it was just asked to do, in
#                                  their own words.
#   UNREAD <count> <oldest-ts> <oldest-sender>
#                                  inbound blocks still at `status: sent`, i.e.
#                                  literally "are they looking at their inbox".
#                                  Emitted only when count > 0.
#
# NO FIELD IS EVER EMPTY, and that is not tidiness. The bash side reads these
# with `IFS=$'\t' read`, and bash treats tab as IFS *WHITESPACE* even when IFS is
# set to tab alone -- so an empty field COLLAPSES and shifts every later field
# left by one. That exact bug has already cost this file once (see the `none`
# sentinel at the compute_inference call site). Every field below is defaulted to
# "-" instead.
#
# THE THREE HEADER SEPARATORS (docs/protocol.md section 5) are normalised to
# " - " before the split. The em dash and en dash are built with printf rather
# than written literally for two independent reasons: this project's leak gate
# refuses a literal U+2014 in any source file, because it IS a field separator
# and a stray one is a latent parsing hazard; and a `\x` escape inside an awk
# regex is a gawk extension that mawk does not implement, so writing them as
# escapes would silently stop normalising anything under a different awk.
DASH_EM=$(printf '\xe2\x80\x94')
DASH_EN=$(printf '\xe2\x80\x93')
INBOX_AWK='
function tsv(s) { gsub(/\t/, " ", s); if (s == "") s = "-"; return s }
# A `## ` line is only a BLOCK HEADER if what follows it is a timestamp. Message
# bodies routinely contain markdown headings -- one live thread carried eight of
# them ("## Executive Summary", "## Conclusion") inside real message bodies --
# and the parser would treat each one as a new block with a prose "timestamp".
#
# THIS GATE IS APPLIED ONLY TO THE MSG/UNREAD RECORDS, deliberately. The
# CARD/DONE/LAST paths are untouched, because they already ignore these
# pseudo-blocks for their own reasons (no metadata region, and a sender that
# matches no agent), and changing the shared header rule would move the
# deterministic pill, which this parser is not the place to reopen. Without the
# gate the digest ranked "Executive Summary..." above "2026-08-17T22:14:32Z" (a
# plain string sort) and the pseudo-blocks pushed the real newest messages
# straight out of the bounded list.
function validts(s) { return (s ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) }
function grab(txt, key,   p, rest, nl) {
  p = index(txt, "\n" key)
  if (p == 0) {
    if (substr(txt, 1, length(key)) == key) rest = substr(txt, length(key) + 1)
    else return ""
  } else rest = substr(txt, p + 1 + length(key))
  nl = index(rest, "\n"); if (nl > 0) rest = substr(rest, 1, nl - 1)
  gsub(/^[ \t]+|[ \t\r]+$/, "", rest)
  return rest
}
function flush(   kind, id, open, low) {
  if (!have) return
  if (sender == AGENT && metatext != "") {
    kind = ""; id = ""
    if (metatext ~ /(^|\n)decision-id:/)    { kind = "decision"; id = grab(metatext, "decision-id:") }
    else if (metatext ~ /(^|\n)action-id:/) { kind = "action";   id = grab(metatext, "action-id:") }
    if (kind != "") {
      # Resolution fields are written by the reader application and are always
      # top-level keys, so the anchor matters: an indented `detail:` line
      # mentioning "done:" is body copy, not a resolution.
      #
      # THE TERMINAL SET IS PER CARD KIND, exactly as docs/protocol.md section
      # 7.1.1 registers it. Three keys each, and they do not overlap except on
      # `dismissed:`:
      #   decision -> answered, dismissed, superseded
      #   action   -> done,     dismissed, superseded
      #
      # `custom-answer:` is NOT one of them, and reading it as one was a real
      # defect rather than a spelling of `answered:`. It is a PAYLOAD field that
      # accompanies `answered: custom`, and the reference writer never emits it
      # without that line. A block carrying it alone is malformed or half-written,
      # and treating that as a resolution silently closes a card nobody answered
      # -- the same failure mode as reading an empty `answered:` placeholder as an
      # answer, which section 7.1.1 also forbids.
      #
      # `superseded:` was previously absent, and its absence was recorded as a
      # deviation rather than fixed, on the reasoning that changing which cards
      # count as open is a behaviour change rather than a transcription. That was
      # right about the change and wrong about the cost of deferring it: a
      # superseded card is closed in the reader application and went on driving
      # the needs-you pill here for the rest of the card window, so the two
      # readers of one document disagreed about a state a person can see.
      #
      # (No apostrophes anywhere in this awk source: it is a single-quoted bash
      # string, and one would terminate it.)
      open = 1
      if (kind == "decision") {
        if (metatext ~ /(^|\n)answered:/) open = 0
      } else {
        if (metatext ~ /(^|\n)done:/) open = 0
      }
      if (metatext ~ /(^|\n)dismissed:/ || metatext ~ /(^|\n)superseded:/) open = 0
      printf "CARD\t%s\t%s\t%s\t%d\t%s\n", ts, kind, tsv(id), open, tsv(subject)
    }
  }
  iscompletion = 0
  if (sender == AGENT && firstbody != "") {
    low = tolower(firstbody)
    # FIRST body line only. A completion report leads with its result; prose
    # deeper in a message says "will be merged" and "not done yet" just as often.
    if (low ~ /(^|[^a-z])(fixed|done|merged|closed|shipped|landed|deployed|completed)([^a-z]|$)/) iscompletion = 1
  }
  # The recency window gates only whether it ENTERS the rolling log; the
  # classification itself is still needed for the last-block wait check below.
  if (iscompletion && (ts "") >= (RECENT_CUTOFF "")) {
    gsub(/\t/, " ", firstbody)
    printf "DONE\t%s\t%s\n", ts, substr(firstbody, 1, 120)
  }
  # ---- both-directions collection for the digest ----
  # A RING BUFFER, not an unbounded array: the thread tail handed to this parse
  # is already bounded by lines, but a thread of very short blocks can still
  # carry hundreds, and this runs once per thread per agent per tick.
  if (MSGS_MAX > 0 && validts(ts)) {
    slot = mcount % MSGS_MAX
    m_ts[slot] = ts; m_sender[slot] = sender; m_status[slot] = status
    m_subj[slot] = substr(subject, 1, SUBJECT_MAX)
    m_body[slot] = substr(firstbody, 1, EXCERPT_MAX)
    mcount++
  }
  # Inbound and still at `status: sent` is the literal observable behind "are
  # they looking at their inbox". Anything not sent BY the agent counts as
  # inbound, because threads carry the occasional third sender, and keying off
  # the correspondent filename instead would silently drop those.
  if (sender != AGENT && status == "sent" && validts(ts)) {
    unread++
    if (unread_oldest == "" || (ts "") < (unread_oldest "")) {
      unread_oldest = ts; unread_from = sender
    }
  }
  lastts = ts; lastsender = sender; laststatus = status; lastdone = iscompletion
}
/^## / {
  flush()
  line = $0
  gsub(" " DASH_EM " ", " - ", line)
  gsub(" " DASH_EN " ", " - ", line)
  n = split(line, parts, / - /)
  ts = substr(parts[1], 4)
  sender = ""; status = ""; subject = ""
  for (i = 2; i <= n; i++) {
    if (substr(parts[i], 1, 6) == "from: ")        sender = substr(parts[i], 7)
    else if (substr(parts[i], 1, 8) == "status: ") status = substr(parts[i], 9)
    else if (substr(parts[i], 1, 9) == "subject: " || parts[i] == "subject:") {
      # The subject is the LAST header field and is free text, so a subject
      # containing " - " has already been split across the remaining parts.
      # Rejoin them rather than truncating at the first dash: "re: merge - second
      # pass" otherwise reads as "re: merge", which is a quietly wrong quote.
      subject = (parts[i] == "subject:") ? "" : substr(parts[i], 10)
      for (j = i + 1; j <= n; j++) subject = subject " - " parts[j]
      i = n
    }
  }
  have = 1; inmeta = 1; metatext = ""; firstbody = ""
  next
}
!have { next }
inmeta && /^[ \t\r]*$/ { inmeta = 0; next }
inmeta { metatext = metatext $0 "\n"; next }
/^---[ \t\r]*$/ { next }
firstbody == "" && /[^ \t\r]/ { firstbody = $0; gsub(/\r/, "", firstbody) }
END {
  flush()
  # tsv() on both string fields, which also fixes a latent bug rather than only
  # serving the newer records: a header with no `from:` or no `status:` emitted
  # an EMPTY field here, and the bash reader collapsed it and read wasCompletion
  # out of the status slot. The "-" placeholder matches neither the agent name
  # nor "sent", so the wait check correctly declines instead of misfiring.
  if (lastts != "") printf "LAST\t%s\t%s\t%s\t%d\n", lastts, tsv(lastsender), tsv(laststatus), lastdone
  if (unread > 0) printf "UNREAD\t%d\t%s\t%s\n", unread, tsv(unread_oldest), tsv(unread_from)
  if (MSGS_MAX > 0) {
    kept = (mcount < MSGS_MAX) ? mcount : MSGS_MAX
    for (k = 0; k < kept; k++) {
      if (m_ts[k] == "") continue
      printf "MSG\t%s\t%s\t%s\t%s\t%s\n", m_ts[k], tsv(m_sender[k]), tsv(m_status[k]),
             tsv(m_subj[k]), tsv(m_body[k])
    }
  }
}
'

# --- recent git commits ----------------------------------------------------------
# Attributed BY WORKTREE, since the author is usually the same person everywhere,
# so a wrong worktree guess produces a wrong completion entry -- which is
# precisely why each entry carries its own `ref` (worktree@sha) and the chip
# carries its confidence. Only the attributed tree is read: one git fork per
# agent, not per candidate. TZ is pinned because the format string claims Z.
git_recent() {  # <worktree>
  [ -n "$1" ] || return 0
  [ -z "${ACTIVITY_NO_GIT:-}" ] || return 0
  TZ=UTC0 git -C "$1" log -n "$RECENT_MAX" --since="$RECENT_WINDOW_H hours ago" \
    --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format='%h%x09%cd%x09%s' 2>/dev/null
}

# The "what is happening RIGHT NOW" half of the digest, and the signal that
# replaces the pane for a heads-down agent. A file being edited is evidence of
# work at 60-second granularity WITHOUT the pane transience: this list changes
# when the WORK moves, not when the screen repaints.
#
# `-uno` on purpose: untracked files tend to be dominated by build output, notes
# and scratch, and they would drown the tracked edits that actually say what is
# being worked on.
#
# TIMEOUT, and it is not decoration. This is a fork per agent on a per-minute
# schedule, and `git status` walks the worktree: a cold page cache or a very
# large repo turns one call into seconds, a dozen of them serially into a tick
# that never finishes, and the single-instance lock then converts every
# subsequent tick into a skip. A timeout degrades to "no dirty list for this
# agent, and a note saying so", which is the honest failure. `timeout` is
# coreutils and usually present, and its absence degrades to running unbounded
# rather than to running nothing.
git_dirty() {  # <worktree> -> porcelain lines, bounded; non-zero if it timed out
  [ -n "$1" ] || return 0
  [ -z "${ACTIVITY_NO_GIT:-}" ] || return 0
  local rc=0 out
  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout "$SIGNAL_GIT_TIMEOUT_SEC" git -C "$1" status --porcelain -uno 2>/dev/null); rc=$?
  else
    out=$(git -C "$1" status --porcelain -uno 2>/dev/null); rc=$?
  fi
  # 124 is timeout(1)'s own signal that it killed the child. Every other non-zero
  # is a git that could not read the tree (not a repo, permissions), which is a
  # legitimate empty answer rather than a fault worth reporting.
  [ "$rc" = "124" ] && return 1
  printf '%s\n' "$out" | sed -e '/^[[:space:]]*$/d' | head -n "$SIGNAL_DIRTY_MAX"
  return 0
}

# --- prior state -----------------------------------------------------------------
prior_json() {  # <agent> <jq-suffix> -> compact JSON, or the literal null
  [ -f "$ACTIVITY_FILE" ] || { echo null; return; }
  jq -c --arg a "$1" ".agents[\$a]$2 // null" "$ACTIVITY_FILE" 2>/dev/null || echo null
}

# --- the model layer's sidecar ---------------------------------------------------
# HARD INVARIANT, tested: an absent, malformed or unknown-schema sidecar changes
# no pill, publishes no prose, and never errors the tick. This layer is strictly
# additive to a sweep that already worked without it.
SIDECAR_OK=0; SIDECAR_DOC='{}'; SIDECAR_FAIL="sidecar-absent"; SIDECAR_META='null'
load_sidecar() {
  [ -f "$INFERENCES_FILE" ] || return 0
  local doc schema
  doc=$(jq -c . "$INFERENCES_FILE" 2>/dev/null) || { SIDECAR_FAIL="malformed-record"; return 0; }
  [ -n "$doc" ] || { SIDECAR_FAIL="malformed-record"; return 0; }
  schema=$(printf '%s' "$doc" | jq -r 'if type == "object" then (.inferenceMeta.schema // "") else "" end' 2>/dev/null)
  # Schema versioning lives on ITS OWN AXIS, never on the document's `schema: 1`:
  # a conforming reader hard-rejects the whole activity document on a schema it
  # does not know, so a producer-side bump there would blank a live panel
  # instantly.
  [ "$schema" = "1" ] || { SIDECAR_FAIL="unknown-schema"; return 0; }
  SIDECAR_DOC="$doc"; SIDECAR_OK=1; SIDECAR_FAIL=""
  SIDECAR_META=$(printf '%s' "$doc" | jq -c '.inferenceMeta // null' 2>/dev/null)
  [ -n "$SIDECAR_META" ] || SIDECAR_META='null'
}

declare -A MCOUNT=()
bump() { MCOUNT["$1"]=$(( ${MCOUNT["$1"]:-0} + 1 )); }

# --- canonical hash inputs -------------------------------------------------------
# Named constants rather than inline programs so a suite can assert against the
# EXACT text production uses, instead of a hand-copied paraphrase that can drift
# from it silently. Six construction details, each of which changes the output:
#   1. every nullable field is read from the record, so JSON null stays null and
#      is distinct from "" (a `--arg` substitution can only ever produce a string);
#   2. `-S` sorts keys, so the bytes do not depend on construction order;
#   3. `try ... catch null`, never `?` -- see the call site;
#   4. no `//` defaulting -- it would fold `false` into null the moment a boolean
#      joins the hashed object;
#   5. `v:2` is a hash-schema version INSIDE the hashed object, so a future change
#      to the field set is deliberate, greppable, and explains a one-off
#      fleet-wide re-inference;
#   6. `.busy` read directly keeps a JSON boolean distinct from the string "true".
#
# Why `recent[0].key` is NOT in contextHash, which is the non-obvious half: it
# used to be, and it nulled prose on every completion. Every inbox message
# starting "Done...", every commit, changed the key and nulled the task line
# immediately -- one measured pass nulled ten of twelve agents' prose at once,
# and under a binding daily call cap nothing replaced it for hours, so the agents
# working HARDEST were nulled most often and re-inferred least. The question
# contextHash answers is "is the prose still about the same thing", and the thing
# is identified by tree and branch. A new completion on the same branch does not
# make the sentence FALSE; it makes it due for a REFRESH, which is bundleHash's
# job. Nulling stays reserved for a genuine context break (tree or branch moved)
# and for the age bounds.
#
# And why `signalHash` rather than a pane hash in bundleHash: the bundle answers
# "is it worth spending a call". A pane repaint is not; a new message, commit or
# dirty-file change is. It also stops the busiest panes burning a day's budget on
# repaints.
CANON_CONTEXT_JQ='{v:2, p:.worktree.path, b:.worktree.branch}'
CANON_BUNDLE_JQ='{v:2, c:$c, g:.signalHash, s:.status, u:.busy}'

# --- the freshness verdict -------------------------------------------------------
# The ONE place `current` is decided, for both consumers. Two hashes do two
# different jobs: contextHash answers "is this prose still about the same thing"
# (and survives the signals moving), signalHash answers "have the signals moved
# at all". Without the grace clause a working agent's task line goes stale within
# minutes of being written and never displays -- for exactly the agents this
# feature exists to describe.
#
# Operators are asymmetric ON PURPOSE and must not be "harmonised": signal-grace
# is a TOLERANCE WINDOW where 0 must mean literally zero, so its comparison is
# strict; max-age is a DURATION ALLOWANCE where the boundary is still inside the
# allowance, so its comparison is inclusive.
#
# staleReason is FIRST MATCH WINS in the order below, timestamp faults first: a
# corrupt record must report the corruption, not a downstream symptom it also
# happens to exhibit.
compute_inference() {  # <agent> <contextHash> <signalHash> -> compact JSON
  local a="$1" ctx="$2" ph="$3"
  local rec="null" reason="" current=false ageeff=0 ageraw=0 pane_moved=false
  local genat="" sweptat="" gen_e="" swept_e="" s_ctx="" s_pane=""
  local show_prose=false

  if [ "$SIDECAR_OK" != "1" ]; then
    reason="$SIDECAR_FAIL"
  else
    rec=$(printf '%s' "$SIDECAR_DOC" | jq -c --arg a "$a" '.agents[$a] // null' 2>/dev/null)
    [ -n "$rec" ] || rec="null"
    if [ "$rec" = "null" ]; then
      reason="no-record"
    elif [ "$(printf '%s' "$rec" | jq -r 'type' 2>/dev/null)" != "object" ]; then
      reason="malformed-record"; rec="null"
    else
      genat=$(printf '%s'   "$rec" | jq -r '.generatedAt // empty' 2>/dev/null)
      sweptat=$(printf '%s' "$rec" | jq -r '.sourceSwept // empty' 2>/dev/null)
      s_ctx=$(printf '%s'   "$rec" | jq -r '.contextHash // empty' 2>/dev/null)
      # `.signalHash` in the sidecar. A record written by a consumer that
      # predates the field has none at all, so it reads as moved and re-infers
      # once, which is the intended one-off cost of that flip.
      s_pane=$(printf '%s'  "$rec" | jq -r '.signalHash  // empty' 2>/dev/null)
      [ "$s_pane" = "$ph" ] || pane_moved=true
      gen_e=$(parse_epoch "$genat")     || gen_e=""
      swept_e=$(parse_epoch "$sweptat") || swept_e=""
      ageraw=0
      [ -n "$gen_e" ] && ageraw=$(( NOW_EPOCH - gen_e ))
      # CLAMP. ageEff is the single non-negative normalised age every downstream
      # consumer sees -- report, ordering, scheduler priority. A negative age
      # there would rank a corrupt record as the freshest thing in the fleet.
      ageeff=$ageraw; [ "$ageeff" -lt 0 ] && ageeff=0

      if   [ -z "$gen_e" ] || [ "$gen_e" -lt "$EPOCH_FLOOR" ];        then reason="bad-timestamp"
      elif [ "$ageraw" -lt $(( 0 - CLOCK_SKEW_TOL_SEC )) ];           then reason="clock-skew"
      elif [ -z "$swept_e" ] || [ "$swept_e" -lt "$EPOCH_FLOOR" ];    then reason="bad-source-swept"
      elif [ $(( NOW_EPOCH - swept_e )) -lt $(( 0 - CLOCK_SKEW_TOL_SEC )) ]; then reason="source-swept-skew"
      elif [ "$s_ctx" != "$ctx" ];                                    then reason="context-changed"
      elif [ "$ageeff" -gt "$MAX_AGE_SEC" ];                          then reason="too-old"
      elif [ "$pane_moved" = "true" ] && [ "$ageeff" -ge "$SIGNAL_GRACE_SEC" ]; then reason="signal-moved"
      else current=true
      fi
    fi
  fi

  # RETENTION. Prose is shown when the record is current, and ALSO when it is
  # stale but its age is still trustworthy and inside the ceiling. The predicate
  # is deliberately expressed as "we can prove how old this sentence is, and it
  # is not too old" rather than as a list of forgivable staleReasons, because
  # that is the property a panel needs and it stays correct if a new reason is
  # added:
  #   - no record, malformed or unknown-schema  -> $rec is null, nothing to retain
  #   - bad-timestamp / clock-skew              -> the age CANNOT be established,
  #                                                so it cannot be shown to be
  #                                                inside the ceiling, and it drops
  #   - too-old                                 -> excluded by the ceiling itself,
  #                                                which is asserted <= MAX_AGE
  #   - context-changed / signal-moved / either
  #     sourceSwept fault                       -> aged, marked, and retained
  if [ "$current" = "true" ]; then
    show_prose=true
  elif [ "$rec" != "null" ] && [ -n "$gen_e" ] && [ "$gen_e" -ge "$EPOCH_FLOOR" ] \
       && [ "$ageraw" -ge $(( 0 - CLOCK_SKEW_TOL_SEC )) ] \
       && [ "$ageeff" -le "$STALE_PROSE_MAX_AGE_SEC" ]; then
    show_prose=true
  fi

  # NOTE FOR ANYONE ADDING COUNTERS: this function is called from a command
  # SUBSTITUTION, which is a subshell, so an increment made in here is discarded
  # on return. The counting therefore happens at the CALL SITE, off the returned
  # object. (The same trap already cost this file its ROOTS_SOURCE provenance
  # once.)
  #
  # THE RULE. It used to be: when current is false the sweep publishes
  # taskLine:null and progressNote:null, full stop. That protected against a
  # confident sentence describing signals that have moved on, and the risk is
  # real -- but it chose SILENCE over MARKING, and consumers have since built the
  # marking (they render the age and a visible stale marker with the reason). The
  # danger was never stale prose, it was UNMARKED stale prose. So the last known
  # prose is now published alongside current:false and its staleReason, up to
  # STALE_PROSE_MAX_AGE_SEC, past which it drops back to null and the panel goes
  # blank rather than presenting archaeology as context. `current` and
  # `staleReason` are unchanged: a consumer that gates on `current` is still
  # correct, it just now has something to gate.
  #
  # THIS jq IS THE OPERATIVE CODE, not the paragraph above it. If they ever
  # disagree, believe the jq.
  #
  # Prose is only ever read from the sidecar. Reading the previous activity.json
  # would make this sweep's output its own input, so one bad publish would echo
  # forever and the prose would lose its traceability to a sidecar record.
  #
  # The object is built from an ALLOWLIST, field by field, never by spreading the
  # sidecar record. A sidecar may carry a model's own read of the STATUS; that
  # must never reach activity.json in either mode, and an allowlist is what makes
  # "prose only, no pill authority" a mechanical property rather than a
  # convention.
  jq -nc --argjson rec "$rec" --argjson cur "$current" --argjson moved "$pane_moved" \
         --argjson age "$ageeff" --arg reason "$reason" --argjson show "$show_prose" \
    '{
       taskLine:     (if $show then ($rec.taskLine     // null) else null end),
       progressNote: (if $show then ($rec.progressNote // null) else null end),
       current:      $cur,
       staleReason:  (if $reason == "" then null else $reason end),
       # WIRE KEY KEPT, MEANING WIDENED: it means "the signals digest has changed
       # since the read". Not renamed to signalMoved, because a consumer may type
       # it as REQUIRED, so a producer-side rename with no coordinated consumer
       # release would drop it to a false default over there and silently stop
       # marking held reads. staleReason renames safely, because every consumer
       # treats it as opaque diagnostic text.
       paneMoved:    $moved,
       ageSeconds:   $age,
       generatedAt:  ($rec.generatedAt // null),
       sourceSwept:  ($rec.sourceSwept // null),
       outcome:      ($rec.outcome     // null)
     }'
}

# --- the signals digest, assembled -----------------------------------------------
# Reads ONLY what this tick already computed: the message/card/unread records the
# inbox awk emitted, the wait state the pill logic derived, the attributed
# worktree, the rolling completions log, and one bounded porcelain fork. It adds
# no new source of truth and no second reader of the raw threads.
#
# Every list is emitted ALREADY CAPPED, so the whole-file cap in
# signal_digest_text is a backstop rather than the only bound. Section order is
# deliberate: the summary lines (unread, open cards, waiting-on) come first
# because they are the smallest and the most "now", and the byte cap keeps the
# head.
signals_age_hours() {  # <iso-ts> -> integer hours, or empty
  local e; e=$(parse_epoch "$1") || return 0
  [ -n "$e" ] || return 0
  local s=$(( NOW_EPOCH - e )); [ "$s" -lt 0 ] && s=0
  printf '%s' $(( s / 3600 ))
}

build_signals_digest() {  # <agent> <record-json> -> digest text on stdout
  local w="$1" rec="$2" n age from to commits
  printf 'INBOX\n'
  if [ "${unread_total:-0}" -gt 0 ]; then
    printf 'unread inbound: %s (oldest %s from %s)\n' \
      "$unread_total" "${unread_oldest_ts:-unknown}" "${unread_oldest_from:-unknown}"
  else
    printf 'unread inbound: 0\n'
  fi

  n=0; [ -s "$TMPD/cards.tsv" ] && n=$(wc -l < "$TMPD/cards.tsv" | tr -d ' ')
  printf 'open cards awaiting an answer: %s\n' "$n"
  if [ "$n" -gt 0 ]; then
    # Newest first, and only CARDS_MAX of them: the count line above already
    # carries the depth of the queue, so the list is there to name what is being
    # waited on, not to enumerate a backlog.
    LC_ALL=C sort -r "$TMPD/cards.tsv" | head -n "$SIGNAL_CARDS_MAX" | \
      while IFS=$'\t' read -r cts ckind cid cto csubj; do
        [ -n "$cts" ] || continue
        age=$(signals_age_hours "$cts")
        [ "$csubj" = "-" ] && csubj=""
        printf -- "- %s '%s' to %s sent %s, unanswered%s%s\n" \
          "$ckind" "$cid" "$cto" "$cts" \
          "${age:+, age ${age}h}" \
          "${csubj:+, subject: $csubj}"
      done
  fi

  if [ -n "${wait_who:-}" ]; then
    printf 'waiting on: %s (last message to them unread, sent %s)\n' "$wait_who" "$wait_ts"
  else
    printf 'waiting on: nobody\n'
  fi

  printf 'recent messages, newest first, all threads:\n'
  if [ -s "$TMPD/msgs.tsv" ]; then
    LC_ALL=C sort -r "$TMPD/msgs.tsv" | head -n "$SIGNAL_MSGS_MAX" | \
      while IFS=$'\t' read -r mts msender mcorr mstatus msubj mbody; do
        [ -n "$mts" ] || continue
        if [ "$msender" = "$w" ]; then from="$w"; to="$mcorr"; else from="$msender"; to="$w"; fi
        [ "$msubj" = "-" ] && msubj=""
        [ "$mbody" = "-" ] && mbody=""
        printf -- "- %s %s -> %s [%s]%s%s\n" \
          "$mts" "$from" "$to" "$mstatus" \
          "${msubj:+ re: $msubj}" \
          "${mbody:+ | $mbody}"
      done
  else
    printf -- '- (none)\n'
  fi

  printf 'GIT\n'
  printf 'worktree: %s branch: %s confidence: %s\n' \
    "$(printf '%s' "$rec" | jq -r '.worktree.path // "none resolved"')" \
    "$(printf '%s' "$rec" | jq -r '.worktree.branch // "unknown"')" \
    "$(printf '%s' "$rec" | jq -r '.worktree.confidence // "none"')"

  if [ "${dirty_failed:-0}" = "1" ]; then
    printf 'uncommitted: not read (git status timed out)\n'
  elif [ -s "$TMPD/dirty.txt" ]; then
    printf 'uncommitted: %s files\n' "$(wc -l < "$TMPD/dirty.txt" | tr -d ' ')"
    sed -e 's/^/- /' "$TMPD/dirty.txt"
  else
    printf 'uncommitted: none\n'
  fi

  printf 'recent commits:\n'
  # From the rolling log rather than a second `git log` fork: it is the same
  # data, already merged and deduped, and a second fork could disagree with the
  # `recent` array a reader sees next to it.
  commits=$(printf '%s' "$rec" | jq -r --argjson n "$SIGNAL_COMMITS_MAX" '
      [(.recent // [])[] | select(.kind == "commit")][0:$n][]
      | "- \(.at) \((.ref // "") | split("@") | last // "") \(.label // "")"' 2>/dev/null)
  if [ -n "$commits" ]; then printf '%s\n' "$commits"; else printf -- '- (none)\n'; fi
}

# --- main sweep ------------------------------------------------------------------
if [ -n "${ACTIVITY_FIXTURE_DIR:-}" ]; then
  windows=$(ls "$ACTIVITY_FIXTURE_DIR" 2>/dev/null | sed 's/\.txt$//' | LC_ALL=C sort)
  windows_rc=0
else
  windows=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null)
  windows_rc=$?
fi

# ZERO WINDOWS IS NEVER AN ANSWER, ONLY A FAILURE TO OBSERVE.
# Without this guard, an unreachable tmux (dead server, missing session, tmux not
# on PATH -- all of which exit non-zero and print nothing) produces an empty
# window list, an empty loop, and then a completely SUCCESSFUL write of
# `agents:{}` over the top of the real file. Three things go wrong at once:
#   - the per-agent rolling completions log exists ONLY in this file and is
#     rebuilt each tick by merging the prior copy, so one blip destroys it
#     permanently for every agent;
#   - the health file records a total outage as `"verdict":"ok"`;
#   - `swept` is stamped with NOW, so every reader's staleness banner -- the one
#     guard built to catch "the engine is down" -- cannot fire, because the data
#     is technically brand new. The reassuring check and the broken check are
#     different checks.
# A dead tmux and a quiet night with no agents are otherwise indistinguishable.
# Refusing the tick keeps the last good file, which is the same stale-but-valid
# degrade the writer at the bottom is built around, and the two causes are
# reported by DISTINCT error strings so the state file answers which one happened.
if [ "$windows_rc" -ne 0 ] || [ -z "$windows" ]; then
  if [ "$windows_rc" -ne 0 ]; then win_fail="tmux-unreachable"; else win_fail="no-windows"; fi
  echo "$SELF: $win_fail; leaving the previous $ACTIVITY_FILE untouched" >&2
  printf '{"swept":"%s","verdict":"error","error":"%s"}\n' "$NOW" "$win_fail" > "$STATE_FILE" 2>/dev/null
  exit 0
fi

build_candidates

PINS='{}'
if [ -f "$PINS_FILE" ]; then
  PINS=$(jq -c . "$PINS_FILE" 2>/dev/null) || PINS='{}'
  [ -n "$PINS" ] || PINS='{}'
fi

TMPD=$(mktemp -d) || exit 0
# $tmpf is cleaned here too. It is deliberately created NEXT TO the target rather
# than inside TMPD (see the write section), so this trap is the only thing
# keeping a crash between mktemp and mv from leaving a straggler in ACTIVITY_ROOT.
trap 'rm -rf "$TMPD"; [ -n "${tmpf:-}" ] && rm -f "$tmpf"' EXIT

declare -a agent_objs=()
declare -a preview_objs=()
declare -a notes=()
swept=0
load_sidecar

# Iterated over a FILE DESCRIPTOR, never `for w in $windows`. The unquoted form
# both word-splits a window name on whitespace and GLOB-EXPANDS it: a window
# named `*` makes the loop iterate every entry in the sweep's working directory,
# inventing an agent record per file, each with its own inbox scan and worktree
# score. tmux window names are settable by anything on the box
# (`tmux rename-window`), so they are input, not constants. Nothing here builds a
# shell command from a window name, so this was never an injection, but it was a
# real way to make the sweep enumerate the wrong universe.
# fd 3 rather than stdin so no command in the body can ever consume the list, and
# `<<<` rather than a pipe so the loop stays in THIS shell, where agent_objs lives.
while IFS= read -r w <&3; do
  [ -n "$w" ] || continue
  case " $SKIP_AGENTS " in *" $w "*) continue;; esac
  pane=$(capture_pane "$w")
  swept=$((swept+1))
  # NOT PERSISTED. The pane is still CAPTURED, because `busy`, `paneHash` and the
  # stuck-pattern match all read it, but it never leaves this process. The
  # signals digest below is the only text this sweep writes to disk, and terminal
  # text is not in it.

  status=""; signal=""; evidence=""; busy=false
  hash=""; unchanged="$NOW"; unchanged_epoch="$NOW_EPOCH"
  # Empty means NO EVIDENCE and publishes null. Distinct from "0", which is the
  # positive claim that a live UI region was read and listed no sub-agents.
  subagents=""

  # ---- pane liveness ----
  if [ -z "$pane" ]; then
    status="unknown"; signal="no-pane"
    evidence="no pane text captured for window '$w'"
  else
    subagents=$(parse_subagent_count "$pane") || subagents=""
    hash=$(pane_hash "$pane")
    prev_hash=$(prior_json "$w" '.paneHash' | tr -d '"')
    if [ -n "$prev_hash" ] && [ "$prev_hash" != "null" ] && [ "$hash" = "$prev_hash" ]; then
      unchanged=$(prior_json "$w" '.paneUnchangedSince' | tr -d '"')
      unchanged_epoch=$(prior_json "$w" '.paneUnchangedSinceEpoch')
      case "$unchanged" in ""|null) unchanged="$NOW";; esac
      case "$unchanged_epoch" in ""|null) unchanged_epoch="$NOW_EPOCH";; esac
    fi
    if check_idle "$pane"; then busy=true; else busy=false; fi
  fi

  # ---- inbox signals ----
  # Gathered BEFORE the pill, so the pill is a pure decision over collected
  # evidence and the same scan also feeds the recent-completions log.
  inbox_dir="$INBOX_ROOT/$w/inbox"
  : > "$TMPD/recent.txt"
  : > "$TMPD/done.tsv"
  : > "$TMPD/msgs.tsv"
  : > "$TMPD/cards.tsv"
  card_kind=""; card_id=""; card_ts=""; card_to=""; card_open=0
  wait_who=""; wait_ts=""
  unread_total=0; unread_oldest_ts=""; unread_oldest_from=""

  if [ -d "$inbox_dir" ]; then
    for f in "$inbox_dir"/*.md; do
      [ -e "$f" ] || continue
      corr="${f##*/}"; corr="${corr%.md}"
      [ "$corr" = "$w" ] && continue          # own-notes thread, not a correspondent
      tail -n "$INBOX_TAIL_LINES" "$f" > "$TMPD/thread.txt" 2>/dev/null || continue
      # Corroboration corpus for the scorer's ticket signal. Appended for every
      # thread, including ones that produce no records.
      tail -n "$CORROB_LINES" "$TMPD/thread.txt" >> "$TMPD/recent.txt" 2>/dev/null
      recs=$(awk -v AGENT="$w" -v RECENT_CUTOFF="$RECENT_CUTOFF" \
                 -v MSGS_MAX="$SIGNAL_MSGS_MAX" -v SUBJECT_MAX="$SIGNAL_SUBJECT_MAX" \
                 -v EXCERPT_MAX="$SIGNAL_MSG_EXCERPT" \
                 -v DASH_EM="$DASH_EM" -v DASH_EN="$DASH_EN" \
                 "$INBOX_AWK" "$TMPD/thread.txt" 2>/dev/null)
      [ -n "$recs" ] || continue
      # SIX fields, not five: CARD carries a subject and MSG has six of its own.
      # Reading with too few variables glues every remaining field into the last.
      while IFS=$'\t' read -r rk a b c d e; do
        case "$rk" in
          CARD)
            # See the HUMANS block near the top: unset means unrestricted, so a
            # fresh install still gets a working needs-you pill.
            if [ -n "$HUMANS" ] && ! is_human "$corr"; then continue; fi
            [ "${d:-0}" = "1" ] || continue
            card_open=$((card_open+1))
            # The digest carries the open cards in full (bounded), while the pill
            # takes only the newest one inside the window. Same records, same
            # correspondent restriction, so the two can never describe different
            # cards.
            printf '%s\t%s\t%s\t%s\t%s\n' "$a" "$b" "$c" "$corr" "${e:--}" >> "$TMPD/cards.tsv"
            # The newest still-open card inside the window drives the pill; older
            # ones are still counted so the evidence line can say how deep the
            # queue is. A card outside the window never drives it -- otherwise
            # one forgotten card from three weeks ago pins `needs-you` on forever.
            if [[ "$a" > "$CARD_CUTOFF" ]] && { [ -z "$card_ts" ] || [[ "$a" > "$card_ts" ]]; }; then
              card_ts="$a"; card_kind="$b"; card_id="$c"; card_to="$corr"
            fi
            ;;
          MSG)
            # Correspondent is added HERE rather than in awk: awk is handed one
            # thread at a time and does not know the filename, and the digest
            # needs the other end of the arrow to render a direction.
            printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$a" "$b" "$corr" "$c" "$d" "$e" >> "$TMPD/msgs.tsv"
            ;;
          UNREAD)
            unread_total=$(( unread_total + ${a:-0} ))
            if [ -n "$b" ] && [ "$b" != "-" ] \
               && { [ -z "$unread_oldest_ts" ] || [[ "$b" < "$unread_oldest_ts" ]]; }; then
              unread_oldest_ts="$b"; unread_oldest_from="$c"
            fi
            ;;
          DONE)
            printf '%s\t%s\t%s\n' "$a" "$b" "$corr" >> "$TMPD/done.tsv"
            ;;
          LAST)
            # Their own last word in a TEAMMATE thread, still unread by that
            # teammate = they are waiting on a person. Configured people are
            # excluded: a person not having read a status note is not a block,
            # and the blocking case with a person IS a card, which is `needs-you`.
            if is_human "$corr"; then continue; fi
            [ "$b" = "$w" ] || continue
            [ "$c" = "sent" ] || continue
            # A COMPLETION REPORT IS NOT A WAIT. Measured against a live fleet: of
            # four agents this pill fired on, three had signed off with "Both
            # done", "Done. Merged origin/main into..." and "Closed from my side"
            # -- unread, but nobody was blocked on anything. Filtering a class the
            # sweep has ALREADY classified for the completions log costs nothing
            # and removes a plainly wrong answer.
            [ "${d:-0}" = "1" ] && continue
            # Decays after WAIT_MAX_MIN: a teammate who never read a message from
            # three days ago would otherwise pin this pill on indefinitely.
            [[ "$a" > "$WAIT_CUTOFF" ]] || continue
            if [ -z "$wait_ts" ] || [[ "$a" > "$wait_ts" ]]; then wait_ts="$a"; wait_who="$corr"; fi
            ;;
        esac
      done <<< "$recs"
    done
  fi
  # Observations are debounced to a a several-minute floor, so they are a
  # stale-tolerant corroboration source and never a liveness signal. Used only to
  # corroborate a ticket id, which is exactly what they are good for.
  obs_dir="$INBOX_ROOT/$w/memory/observations"
  if [ -d "$obs_dir" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      tail -n "$CORROB_LINES" "$obs_dir/$f" >> "$TMPD/recent.txt" 2>/dev/null
    done < <(ls -t "$obs_dir" 2>/dev/null | head -3)
  fi

  # ---- status pill (first match wins) ----
  if [ -n "$pane" ]; then
    if [ "$busy" = "true" ]; then
      status="working"; signal="pane-busy"
      evidence="pane is mid-turn (busy marker in the live capture)"
    elif hit=$(match_pattern "$pane"); then
      # REPORT ONLY. Escalating this is stuck-pane-sweep.sh's job and must stay
      # exactly one system's job; a second escalator into the same pane is a wake
      # storm with two authors and no owner.
      status="stuck"; signal="stuck-pattern"
      evidence="known stuck dialog in the live tail: \"$hit\" (reported only, escalation stays stuck-pane-sweep's)"
    # LAST OF THE DIRECT PANE OBSERVATIONS, and deliberately ahead of every inbox
    # inference below: an agent idle-waiting on sub-agents it dispatched itself is
    # not waiting on a person, whatever its card queue looks like.
    #
    # It is BELOW `stuck` on purpose: a wedged dialog blocks the session
    # regardless of what is running under it, and the sub-agents' results land
    # straight into that wedged session. `busy` is checked first and outranks it
    # vacuously.
    #
    # Nothing is lost by outranking the card: no state is carried and no card is
    # consumed. The moment the count drops to 0 (or the live region goes away),
    # the very next tick falls through to the card branch and the pill returns to
    # `needs-you`.
    #
    # BOTH HALVES OF THE GUARD ARE LOAD-BEARING, matching the 0/null split
    # established where `subagents` is parsed: "" means NO LIVE UI REGION (a
    # foreign pane, no evidence either way) and "0" means the region was read and
    # listed nothing. Only a positive count is evidence, so both fall through
    # untouched. `-n` also has to come first for a second reason: `[ "" -gt 0 ]`
    # is a bash ERROR, not a false.
    elif [ -n "$subagents" ] && [ "$subagents" -gt 0 ]; then
      status="waiting-on-machine"; signal="pane-subagents"
      evidence="idle pane, $subagents running sub-agent(s) listed in the live UI region"
    elif [ -n "$card_ts" ]; then
      status="needs-you"; signal="inbox-card"
      evidence="unanswered $card_kind card '$card_id' to $card_to, open since $card_ts"
      [ "$card_open" -gt 1 ] && evidence="$evidence ($card_open open in total)"
    elif [ -n "$wait_who" ]; then
      status="waiting-on-teammate"; signal="inbox-unread-outbound"
      evidence="their last message to $wait_who is still unread by $wait_who, sent $wait_ts"
    else
      status="done-for-now"; signal="idle-no-signal"
      evidence="idle since $unchanged, no open cards and no unread outbound"
    fi
  fi

  idle_min=null
  if [ "$busy" = "false" ] && [ -n "$pane" ]; then
    idle_min=$(( (NOW_EPOCH - unchanged_epoch) / 60 ))
    [ "$idle_min" -lt 0 ] && idle_min=0
  fi

  # ---- status duration: when did THIS STATUS begin, not when did the sweep last run ----
  # Same idiom as paneUnchangedSince above, applied to the now-finalised `status`
  # rather than the pane hash: default to NOW, then ONLY if the prior tick's
  # status is identical to this tick's, carry the prior tick's since-value
  # forward instead (with the same null/empty guard degrading to NOW).
  # Deliberately placed here, after the whole cascade above has settled on a
  # final `status`, rather than interleaved into it: one comparison covers every
  # branch (including any added later) instead of one ad-hoc carry-forward per
  # branch.
  status_since="$NOW"; status_since_epoch="$NOW_EPOCH"
  prev_status=$(prior_json "$w" '.status' | tr -d '"')
  if [ -n "$prev_status" ] && [ "$prev_status" != "null" ] && [ "$prev_status" = "$status" ]; then
    status_since=$(prior_json "$w" '.statusSince' | tr -d '"')
    status_since_epoch=$(prior_json "$w" '.statusSinceEpoch')
    case "$status_since" in ""|null) status_since="$NOW";; esac
    case "$status_since_epoch" in ""|null) status_since_epoch="$NOW_EPOCH";; esac
  fi

  # ---- worktree attribution ----
  g_path=""; g_branch=""; g_conf=""; g_score=0; g_reasons=""
  guess_json='null'
  pin_path=$(printf '%s' "$PINS" | jq -r --arg a "$w" '.[$a].path // empty' 2>/dev/null)
  ranked=$(score_worktrees "$w" "$TMPD/recent.txt")
  top_line=$(printf '%s\n' "$ranked" | sed -n '1p')
  second_score=$(printf '%s\n' "$ranked" | sed -n '2p' | cut -f1)
  alts=$(printf '%s\n' "$ranked" | sed -n '2,4p' | jq -Rsc \
    'split("\n") | map(select(length>0)) | map(split("\t"))
     | map(select(length>=4)) | map({path:.[2], branch:.[3], score:(.[0]|tonumber)})' 2>/dev/null)
  [ -n "$alts" ] || alts='[]'

  if [ -n "$top_line" ]; then
    g_score=$(printf '%s' "$top_line" | cut -f1)
    g_path=$(printf '%s' "$top_line" | cut -f3)
    g_branch=$(printf '%s' "$top_line" | cut -f4)
    g_reasons=$(printf '%s' "$top_line" | cut -f5)
    g_conf=$(confidence_for "${g_score:-0}" "${second_score:-0}")
    guess_json=$(jq -nc --arg p "$g_path" --arg b "$g_branch" --arg c "$g_conf" \
      --argjson s "${g_score:-0}" --arg r "$g_reasons" --argjson alt "$alts" \
      '{path:$p, branch:$b, confidence:$c, score:$s,
        reasons: ($r | split(";") | map(select(length>0))), alternatives:$alt}')
  fi

  if [ -n "$pin_path" ]; then
    # A pin ALWAYS wins. The guess is kept alongside rather than discarded so a
    # stale pin is visible next to what the scorer would have said -- a pin that
    # silently hides a disagreement is how a pin becomes the new wrong answer.
    pin_branch=""
    j=0; while [ "$j" -lt "${#WT_PATHS[@]}" ]; do
      if [ "${WT_PATHS[$j]}" = "$pin_path" ]; then pin_branch="${WT_BRANCHES[$j]}"; break; fi
      j=$((j+1))
    done
    wt_json=$(jq -nc --arg p "$pin_path" --arg b "$pin_branch" --argjson g "$guess_json" \
      --argjson meta "$(printf '%s' "$PINS" | jq -c --arg a "$w" '.[$a] // {}')" \
      '{path:$p, branch:(if $b == "" then null else $b end), confidence:"pinned", score:null,
        pinned:true, pinnedBy:($meta.by // null), pinnedAt:($meta.at // null),
        reasons:["pinned override"], alternatives:[], guess:$g}')
    attributed="$pin_path"
  elif [ "$guess_json" != "null" ]; then
    wt_json=$(printf '%s' "$guess_json" | jq -c '. + {pinned:false, guess:null}')
    attributed="$g_path"
  else
    wt_json=$(jq -nc '{path:null, branch:null, confidence:"none", score:0, pinned:false,
                       reasons:["no candidate worktree scored above zero"],
                       alternatives:[], guess:null}')
    attributed=""
  fi

  # ---- recent completions: APPEND AND CAP, never replace ----
  : > "$TMPD/fresh.jsonl"
  if [ -s "$TMPD/done.tsv" ]; then
    while IFS=$'\t' read -r ts label corr; do
      [ -n "$ts" ] || continue
      jq -nc --arg at "$ts" --arg l "$label" --arg r "$corr.md" \
        '{key:("inbox:"+$r+":"+$at), at:$at, kind:"inbox", label:$l, ref:$r}' >> "$TMPD/fresh.jsonl"
    done < "$TMPD/done.tsv"
  fi
  if [ -n "$attributed" ]; then
    while IFS=$'\t' read -r sha cdate subj; do
      [ -n "$sha" ] || continue
      jq -nc --arg at "$cdate" --arg l "$subj" --arg r "${attributed##*/}@$sha" --arg sha "$sha" \
        '{key:("commit:"+$sha), at:$at, kind:"commit", label:$l, ref:$r}' >> "$TMPD/fresh.jsonl"
    done < <(git_recent "$attributed")
  fi
  fresh=$(jq -sc . "$TMPD/fresh.jsonl" 2>/dev/null); [ -n "$fresh" ] || fresh='[]'
  prior_recent=$(prior_json "$w" '.recent')
  [ "$prior_recent" = "null" ] && prior_recent='[]'

  # ---- emit ----
  rec=$(jq -nc \
    --arg agent "$w" --arg status "$status" --arg signal "$signal" --arg evidence "$evidence" \
    --argjson busy "$busy" --arg hash "$hash" --arg unchanged "$unchanged" \
    --argjson unchangedEpoch "${unchanged_epoch:-0}" --argjson idleMinutes "$idle_min" \
    --arg statusSince "$status_since" --argjson statusSinceEpoch "${status_since_epoch:-0}" \
    --argjson worktree "$wt_json" --argjson fresh "$fresh" --argjson prior "$prior_recent" \
    --argjson cap "$RECENT_MAX" --arg updated "$NOW" \
    '{agent:$agent, status:$status, signal:$signal, evidence:$evidence,
      busy:$busy, idleMinutes:$idleMinutes,
      paneHash:$hash, paneUnchangedSince:$unchanged, paneUnchangedSinceEpoch:$unchangedEpoch,
      statusSince:$statusSince, statusSinceEpoch:$statusSinceEpoch,
      worktree:$worktree,
      recent: (($fresh + $prior) | unique_by(.key) | sort_by(.at) | reverse | .[0:$cap]),
      updated:$updated}')

  # ---- signals digest ----
  # Assembled AFTER the record, because it renders the worktree, the confidence
  # and the rolling completions log the record just settled -- one source, so the
  # digest and the card can never describe different worktrees.
  #
  # THE HASH DESCRIBES WHAT A CONSUMER CAN READ, and that is the whole invariant
  # here. It is computed from the assembled TEXT (the file is never re-read, so a
  # reader and a writer can never disagree about its bytes) but it is PUBLISHED
  # only when that text is the digest now on disk. Anything else -- persistence
  # off, the directory refused, a foreign target, a failed write, a failed
  # redaction -- leaves signalHash null and leaves no digest of this system's own
  # behind.
  #
  # The obvious alternative (publish the hash regardless) is wrong on a premise
  # rather than in its reasoning: it assumes a refused write means "no digest on
  # disk", which holds only on the first tick. With an older digest already
  # there, publishing this tick's hash makes the record advertise a digest no
  # consumer ever saw, and the next tick reads that hash back as "already judged"
  # and skips the re-read that should have happened. bundleHash does not go flat
  # as a result: contextHash, status and busy still move it.
  : > "$TMPD/dirty.txt"
  dirty_failed=0
  if [ -n "$attributed" ]; then
    if ! git_dirty "$attributed" > "$TMPD/dirty.txt" 2>/dev/null; then
      dirty_failed=1
      notes+=("uncommitted-file list skipped for $w: git status exceeded ${SIGNAL_GIT_TIMEOUT_SEC}s")
    fi
  fi
  signal_hash=""
  if signals_text=$(signal_digest_text "$(build_signals_digest "$w" "$rec")"); then
    if persist_signals_digest "$w" "$signals_text"; then
      signal_hash=$(printf '%s' "$signals_text" | sha256sum 2>/dev/null | cut -c1-16)
    fi
  else
    notes+=("signals digest dropped for $w: redaction failed")
    # A dropped capture is a refresh that did not land like any other, so the
    # same rule applies: a digest from an earlier tick must not survive as the
    # answer.
    discard_stale_digest "$w"
  fi
  # subagentCount rides along here rather than in the record jq above, because it
  # is the same class of field as inboxUnreadInbound: an optional deterministic
  # count a reader may not have a renderer for yet. Empty -> null, which is "no
  # live UI region to read", kept distinct from 0, which is "read it, nothing
  # listed".
  rec=$(printf '%s' "$rec" | jq -c --arg sh "$signal_hash" --argjson unread "${unread_total:-0}" \
          --arg sub "${subagents:-}" \
          '. + {signalHash: (if $sh == "" then null else $sh end), inboxUnreadInbound: $unread,
                subagentCount: (if $sub == "" then null else ($sub|tonumber) end)}')

  # ---- deterministic hashes ----
  # Canonical compact JSON with sorted keys, hashed as bytes, read STRAIGHT OFF
  # the record so every field keeps its real JSON type. A pipe-joined string
  # cannot do this: `jq --arg` always produces a JSON string, so a null worktree
  # path would hash identically to an empty one, and a `|` inside a branch name
  # (git permits it) collides with a `|` inside a path.
  #
  #   contextHash  "is the prose still about the same thing"  (survives signal movement)
  #   bundleHash   "is it worth spending a call"              (any signal movement counts)
  #
  # Both are computed ONLY here. A consumer echoes back what it read, so
  # producer/consumer drift is structurally impossible rather than merely tested
  # for.
  canon_context=$(printf '%s' "$rec" | jq -cS "$CANON_CONTEXT_JQ" 2>/dev/null)
  # `try ... catch null`, never `?`: a postfix `?` produces an EMPTY STREAM on
  # error, and an empty stream inside object construction makes the whole object
  # produce no output -- canon_context would be "" and every agent would hash
  # sha256(""). `printf '%s'`, never a pipe from jq: command substitution has
  # already stripped jq's trailing newline, so the hashed bytes are exactly the
  # compact JSON.
  contextHash=$(printf '%s' "$canon_context" | sha256sum 2>/dev/null | cut -c1-16)
  case "$contextHash" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) fail_closed "hash-failed" "contextHash malformed for $w" ;;
  esac
  # $contextHash is the only --arg left, and the assertion above is what makes it
  # safe: it is provably a 16-character lowercase hex string, never null.
  canon_bundle=$(printf '%s' "$rec" | jq -cS --arg c "$contextHash" "$CANON_BUNDLE_JQ" 2>/dev/null)
  bundleHash=$(printf '%s' "$canon_bundle" | sha256sum 2>/dev/null | cut -c1-16)
  rec=$(printf '%s' "$rec" | jq -c --arg ch "$contextHash" --arg bh "$bundleHash" \
          '. + {contextHash: $ch, bundleHash: $bh}')

  # ---- model-layer merge: computed ALWAYS, published CONDITIONALLY ----
  # Computing in both modes is the point: shadow exercises the real parse, the
  # real validation, the real hash comparison and the real nulling against real
  # data, so the live flip changes placement only. The single decision point is
  # here.
  inf=$(compute_inference "$w" "$contextHash" "$signal_hash")
  # `none` is a SENTINEL, not decoration. Tab is IFS *whitespace*, so `read`
  # folds a leading empty field away entirely: an empty staleReason (the
  # current-record case) shifted every field left by one and made a fresh record
  # read as `current=false` with a reason of "true". Caught by a smoke test, not
  # by inspection -- an empty field is not a value you can pass through `read` on
  # a whitespace IFS.
  IFS=$'\t' read -r inf_reason inf_current inf_moved < <(printf '%s' "$inf" | \
    jq -r '[(.staleReason // "none"), (.current | tostring), (.paneMoved | tostring)] | @tsv')
  case "$inf_reason" in
    bad-timestamp)     bump badTimestamp ;;
    clock-skew)        bump clockSkew ;;
    bad-source-swept)  bump badSourceSwept ;;
    source-swept-skew) bump sourceSweptSkew ;;
    context-changed)   bump contextChanged ;;
    too-old)           bump tooOld ;;
    signal-moved)      bump signalMovedStale ;;
    no-record)         bump noRecord ;;
    sidecar-absent|malformed-record|unknown-schema) bump noSidecar ;;
  esac
  if [ "$inf_current" = "true" ]; then
    bump current
    # The signal-grace relaxation firing is COUNTED, not hidden: it is a
    # deliberate false-positive window (an agent that finished task A and started
    # task B in the same tree with no new signal recorded), and the counter is
    # what lets the window be shortened later on data rather than on feel.
    [ "$inf_moved" = "true" ] && bump graceHeld
  fi
  if [ "$MODEL_MODE" = "live" ]; then
    rec=$(printf '%s' "$rec" | jq -c --argjson inf "$inf" '. + {inference: $inf}')
  else
    preview_objs+=("$(printf '%s' "$inf" | jq -c --arg a "$w" '{($a): .}')")
  fi
  agent_objs+=("$rec")
done 3<<< "$windows"

# SECOND GUARD on the same invariant as the enumeration check above: never
# publish an empty agents map over a populated one. The first guard catches the
# way this actually happens (tmux returning nothing); this one catches every
# other route to the same wipe -- a whitespace-only window list, a SKIP_AGENTS
# covering the whole roster, or a future edit that drops records earlier in the
# loop. Refusing with the previous file intact is the same degrade, and the
# reason is distinct again so the health file never has to be guessed at.
if [ "${#agent_objs[@]}" -eq 0 ]; then
  echo "$SELF: no agent produced a record; leaving the previous $ACTIVITY_FILE untouched" >&2
  printf '{"swept":"%s","verdict":"error","error":"no-agents-swept"}\n' "$NOW" > "$STATE_FILE" 2>/dev/null
  exit 0
fi

[ "${#WT_PATHS[@]}" -gt 0 ] || notes+=("no candidate worktrees found under the configured roots")

# --- assemble ---------------------------------------------------------------------
# The merge counters this tick produced, plus whatever a model layer recorded in
# its own sidecar meta. Two different corpora, deliberately separate names: a
# non-zero clockSkew points at the box clock or a foreign writer of the sidecar;
# a non-zero errors/unreconciled points at the model layer's own run.
merge_counts='{}'
# `${#MCOUNT[@]}` guard, not `${!MCOUNT[@]+...}`: the `+` alternate-value form is
# parsed as an INDIRECT expansion when the parameter starts with `!`, and errors
# out with "invalid variable name" the moment the array is non-empty.
if [ "${#MCOUNT[@]}" -gt 0 ]; then
  for _k in "${!MCOUNT[@]}"; do
    merge_counts=$(printf '%s' "$merge_counts" | jq -c --arg k "$_k" --argjson v "${MCOUNT[$_k]}" '.[$k] = $v')
  done
fi
inference_meta=$(jq -nc --argjson m "$SIDECAR_META" --argjson c "$merge_counts" \
  --arg mode "$MODEL_MODE" --arg swept "$NOW" --arg fail "$SIDECAR_FAIL" \
  '{schema: 1, sweepMode: $mode, mergedAt: $swept,
    sidecar: (if $m == null then null else
      {ranAt: $m.ranAt, mode: $m.mode, modelId: $m.modelId, modelVersion: $m.modelVersion,
       keyPresent: $m.keyPresent, modelPinOk: $m.modelPinOk,
       spendUsd: $m.spendUsd, callsToday: $m.callsToday, counters: $m.counters} end),
    sidecarFault: (if $fail == "" then null else $fail end),
    counters: $c}')

doc=$(printf '%s\n' "${agent_objs[@]+"${agent_objs[@]}"}" | jq -sc \
  --arg swept "$NOW" --arg gen "$SELF" --argjson cand "${#WT_PATHS[@]}" \
  --arg rootsSource "$ROOTS_SOURCE" --arg mode "$MODEL_MODE" --argjson im "$inference_meta" \
  --argjson notes "$(printf '%s\n' "${notes[@]+"${notes[@]}"}" | jq -Rsc 'split("\n") | map(select(length>0))')" \
  '{schema:1, generator:$gen, swept:$swept, worktreeCandidates:$cand,
    worktreeRootsSource:$rootsSource, notes:$notes,
    agents: (map(select(type=="object" and .agent != null)) | map({(.agent): del(.agent)}) | add // {})}
   + (if $mode == "live" then {inferenceMeta: $im} else {} end)')

# --- shadow output ------------------------------------------------------------------
# Shadow does NOT merge the inference object into activity.json under a different
# key -- it does not merge it AT ALL. The tempting "provably inert because the
# panel only reads `inference`" argument is true of the panel and false of the
# SYSTEM: bin/activity's --json paths are raw passthroughs of the whole agent
# record, so any key merged in leaks to every scripted consumer. The computed
# result goes here instead, 0600, which also makes shadow-inertness a BEHAVIOUR
# test (this file proves the path ran while a recursive scan of activity.json
# finds nothing) rather than a source-code assertion a future edit could silently
# invalidate.
if [ "$MODEL_MODE" = "live" ] && [ "${ACTIVITY_DRY_RUN:-0}" != "1" ]; then
  # A preview left behind by an earlier shadow tick keeps presenting an old merge
  # as though it were current, and it is the file a reviewer reaches for. Live
  # publishes the real thing, so the preview is removed rather than left to rot
  # next to it.
  rm -f "$MERGE_PREVIEW_FILE" 2>/dev/null
elif [ "${ACTIVITY_DRY_RUN:-0}" != "1" ]; then
  preview=$(printf '%s\n' "${preview_objs[@]+"${preview_objs[@]}"}" | jq -sc \
    --arg swept "$NOW" --arg mode "$MODEL_MODE" --argjson im "$inference_meta" \
    '{previewedAt:$swept, mode:$mode, inferenceMeta:$im,
      agents: (map(select(type == "object")) | add // {})}')
  if ! { [ -L "$MERGE_PREVIEW_FILE" ] || { [ -e "$MERGE_PREVIEW_FILE" ] && [ ! -f "$MERGE_PREVIEW_FILE" ]; }; }; then
    ptmp=$(mktemp "$ACTIVITY_ROOT/.merge-preview.json.XXXXXX" 2>/dev/null) && {
      chmod 600 "$ptmp" 2>/dev/null
      printf '%s\n' "$preview" > "$ptmp" 2>/dev/null && mv -f "$ptmp" "$MERGE_PREVIEW_FILE" 2>/dev/null \
        || rm -f "$ptmp" 2>/dev/null
    }
  fi
fi

if [ "${ACTIVITY_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$doc" | jq -r '.agents | to_entries[] |
    "AGENT \(.key): \(.value.status) [worktree=\(.value.worktree.path // "-") conf=\(.value.worktree.confidence)] -- \(.value.evidence)"'
  printf '%s\n' "$doc" | jq -r '.agents | to_entries[] as $e | $e.value.recent[]? |
    "RECENT \($e.key): \(.at) \(.kind) \(.label)"'
  echo "SWEPT: $swept agents, ${#WT_PATHS[@]} worktree candidates ($ROOTS_SOURCE roots)"
  exit 0
fi

# --- write ------------------------------------------------------------------------
# Atomic replace. Both readers read this on their own schedule; a half-written
# file gives a reader a parse error instead of stale-but-valid data, and
# stale-but-valid is always the better degrade.
#
# The temp file is created IN ACTIVITY_ROOT, not in TMPD. `mv` is only atomic
# WITHIN one filesystem; across filesystems it silently degrades to
# copy-then-unlink, which is exactly the half-written read this block exists to
# prevent. TMPD follows TMPDIR, which may or may not be the same device as the
# state dir. Same-directory is the only version that is atomic BY CONSTRUCTION
# rather than by a property of one machine. TMPD stays the fallback if
# ACTIVITY_ROOT is not writable, where the mv below is going to fail and report
# anyway.
tmpf=$(mktemp "$ACTIVITY_ROOT/.activity.json.XXXXXX" 2>/dev/null) || tmpf="$TMPD/activity.json"
if ! printf '%s\n' "$doc" | jq . > "$tmpf" 2>/dev/null; then
  printf '{"swept":"%s","verdict":"error","error":"assemble-failed"}\n' "$NOW" > "$STATE_FILE"
else
  # mktemp creates 0600. The published file has to keep the mode its readers
  # already have, so --reference preserves it exactly wherever one is live, and
  # 644 is the default on a fresh install. Without this the first tick after any
  # change would quietly narrow the file's permissions.
  chmod --reference="$ACTIVITY_FILE" "$tmpf" 2>/dev/null || chmod 644 "$tmpf" 2>/dev/null
  if mv -f "$tmpf" "$ACTIVITY_FILE" 2>/dev/null; then
    printf '{"swept":"%s","verdict":"ok","agents":%d,"worktreeCandidates":%d,"file":"%s"}\n' \
      "$NOW" "$swept" "${#WT_PATHS[@]}" "$ACTIVITY_FILE" > "$STATE_FILE"
  else
    # PUBLISH failed: unwritable dir, read-only mount, ACTIVITY_ROOT deleted
    # under us. Ignoring mv's exit status and reporting "ok" would hide the
    # single fact a reader most needs -- the file you are reading is NOT the file
    # this tick produced.
    printf '{"swept":"%s","verdict":"error","error":"publish-failed"}\n' "$NOW" > "$STATE_FILE"
  fi
fi

exit 0
