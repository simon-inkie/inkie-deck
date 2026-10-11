#!/usr/bin/env bash
# inbox-push.test.sh -- branch coverage for inbox-push using the PANE_OVERRIDE*
# test seams (no live tmux). Verifies the send-keys footgun gates AND the
# synchronous capture-verify branches. Covers both claude and agy (Gemini)
# runtime panes; the RUNTIME_OVERRIDE seam exercises the runtime gate in test
# mode without needing a live .runtime file. The single exception is the
# AGENTS_HOME case, which must leave test mode to read a real .runtime file and
# stands up a stub `tmux` on PATH rather than contacting a tmux server.
#
# Run: packages/base/test/inbox-push.test.sh

set +e
# Test the inbox-push IN THIS CHECKOUT, resolved relative to this file, not
# whichever copy happens to be installed: with the path hardcoded to an absolute
# install location, running this suite from a git worktree silently graded the
# INSTALLED script instead of the branch under test (a green run that proved
# nothing about the change). INBOX_PUSH_BIN overrides.
PUSH="${INBOX_PUSH_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)/inbox-push}"
export AGENT_NAME=courier

PASS=0
FAIL=0

# run_case <name> <expected_verdict> <expected_rc> -- env seams are exported by
# the caller (inside an isolation subshell). Prints the line; RETURNS 0 on pass,
# 1 on fail. The parent tallies via the subshell exit code (counters can't cross
# the subshell boundary, so we never increment them inside run_case).
run_case() {
  local name="$1" exp_verdict="$2" exp_rc="$3"
  local out rc
  out="$("$PUSH" "$REC" "$MSG" 2>&1)"
  rc=$?
  if [ "$out" = "$exp_verdict" ] && [ "$rc" = "$exp_rc" ]; then
    printf 'PASS  %-42s -> %s (rc=%s)\n' "$name" "$out" "$rc"
    return 0
  fi
  printf 'FAIL  %-42s -> got "%s" (rc=%s), want "%s" (rc=%s)\n' \
    "$name" "$out" "$rc" "$exp_verdict" "$exp_rc"
  return 1
}

# tally <rc> -- count a case result by the isolation subshell's exit code.
tally() { if [ "${1:-1}" -eq 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }

# Common pane fixtures (claude)
IDLE_CLEAN=$'some transcript output\n\n> '
# Context-gate fixtures. Real statusline shapes, both live formats. The ctx bar is
# the anchor, NOT the model name: an "Opus"-anchored parser went blind to every
# Sonnet/Haiku agent when the model mix changed.
IDLE_CTX_92=$'some transcript output\n\n> \n  alice \xe2\x94\x82 Opus 5 \xe2\x94\x82 ~/agents/alice \xe2\x94\x82 \xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x91 92%'
IDLE_CTX_46=$'some transcript output\n\n> \n  alice \xe2\x94\x82 Opus 5 \xe2\x94\x82 ~/agents/alice \xe2\x94\x82 \xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x91\xe2\x96\x91\xe2\x96\x91\xe2\x96\x91\xe2\x96\x91\xe2\x96\x91 46%'
IDLE_CTX_80=$'some transcript output\n\n> \n  alice \xe2\x94\x82 Opus 5 \xe2\x94\x82 ~/agents/alice \xe2\x94\x82 \xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x91\xe2\x96\x91 80%'
IDLE_CTX_ALT=$'some transcript output\n\n> \n  ~/agents/alice  Opus 5  ctx:91%'
BUSY=$'· Thinking... (esc to interrupt)\n> '
BUSY_STAGED=$'· Thinking... (esc to interrupt)\n> half-typed while busy'
STAGED_FOREIGN=$'output\n> half-typed staged text'
# Our own push as the terminal renders it when it wraps: only the glyph-bearing
# line is visible, so the composer shows a PREFIX of MSG, not the whole thing.
STAGED_OURS=$'output\n> [inbox from courier] hel'
# A REAL busy pane as Claude renders it today, captured live off alice
# 2026-07-26 while he was mid-turn. Deliberately kept verbatim: every
# enumerated literal in check_idle misses this line, which is why a busy pane
# read as idle. Multi-word status, a hyphen inside the first token, and a
# U+2026 terminator rather than three ASCII dots. The only thing that survives
# is the parenthesised elapsed counter.
BUSY_MODERN=$'\xc2\xb7 BUG-609 (High): "info not saving" churn bug - audit\xe2\x80\xa6 (59s \xc2\xb7 thought for 2s)\n\xe2\x9d\xaf '
# 2026-07-27: the counter does NOT always carry a middot. BUSY_MODERN and
# COMPACTING both do, so they were the only counter fixtures and the suite pinned
# the SHAPE the 26 July incident produced rather than the CATEGORY it belonged to.
# These two are the forms that read as IDLE while genuinely busy. Found live on
# alice mid-compact showing "(1m 26s)".
BUSY_BARE_SECONDS=$'\xc2\xb7 Thinking\xe2\x80\xa6 (12s)\n\xe2\x9d\xaf '
# alice, 2026-07-27: the spinner glyph is NOT a closed set. Measured ✽ (U+273D) live on
# another agent's pane, outside the class the first anchored fix enumerated. This fixture pins
# a glyph nobody has enumerated AND a status word nobody has enumerated, so it can
# only pass via the structural end-of-line counter rule.
BUSY_UNKNOWN_GLYPH=$'\xe2\x9c\xbd Dilly-dallying\xe2\x80\xa6 (16s)\n\xe2\x9d\xaf '
BUSY_BARE_MINUTES=$'\xc2\xb7 Auditing the sentinel ledger\xe2\x80\xa6 (1m 26s)\n\xe2\x9d\xaf '
# NEGATIVE CONTROLS. A completed-turn summary carries a spinner glyph and a
# duration but the turn is OVER: these must read IDLE or every finished agent
# looks permanently busy and delivery wedges.
DONE_BREWED=$'\xe2\x9c\xbb Brewed for 39s\n\xe2\x9d\xaf \xc2\xa0'
DONE_WORKED=$'\xe2\x9c\xbb Worked for 2m 24s\n\xe2\x9d\xaf \xc2\xa0'
# And prose: panes are full of message text, so a parenthesised duration in a
# sentence must NOT read as busy. This is the false-positive an unanchored
# widening would introduce.
PROSE_WITH_DURATION=$'  I hit it live: my pane showed (1m 26s) mid-compact\n\xe2\x9d\xaf \xc2\xa0'
NO_COMPOSER=$'output with no prompt glyph at all'
# The REAL idle Claude composer: prompt glyph (U+276F) + a NO-BREAK SPACE
# (U+00A0, bytes C2 A0), NOT a regular space. [[:space:]] does not reliably
# treat the NBSP as whitespace, so this used to false-skip:staged on every idle
# pane (the default-on push was silently no-op). Must read as CLEAN.
IDLE_CLEAN_NBSP=$'some transcript output\n\n\xe2\x9d\xaf\xc2\xa0'
# Compacting: captured LIVE off alice's pane mid-/compact, 2026-07-09 (the exact
# line that missed every prior busy marker -- two words + a UNICODE ellipsis
# U+2026, not one word + three ASCII dots, so spinner_re never matched, and
# neither "esc to interrupt" nor "Cerebrating" show during a real compact).
# This is the fixture that regression-locks the "message dropped during
# /compact" fix (2026-07-09).
COMPACTING=$'* Compacting conversation\xe2\x80\xa6 (8s \xc2\xb7 \xe2\x86\x91 3.5k tokens)\n> '

# BACKGROUND-TASK LIST BELOW THE COMPOSER (2026-07-29). Modelled on a live
# capture off alice's pane while a general-purpose subagent was visible. The
# STRUCTURE is the load-bearing part: a rule carrying the agent's name, the REAL
# (empty, idle) composer, the closing rule, the status bar, then "● main" and a
# task-list entry Claude ALSO prefixes with ❯. That entry is the LAST ❯ line in
# the capture, so `grep '^[[:space:]]*(❯|›|>)' | tail -1` returned it, read
# "◯ general-purpose ..." as staged text, and every live push to that agent
# silently skipped for as long as the subagent stayed visible -- three human
# DMs to alice sat persisted-but-undelivered for 32+ minutes, twice in one
# evening. Must read CLEAN: the composer is the prompt line under the RULE, not
# the last one in the pane.
IDLE_WITH_BG_TASK_LIST_BELOW_COMPOSER=$'  … +3 in progress, 19 pending, 42 completed\n                        new task? /clear to save 235.9k tokens\n──────────────────────────────────────── alice ──\n❯  \n────────────────────────────────────────────────\n  alice │ Sonnet 5 │ ~/agents/alice │ ██░░░░░░░░ 29%    /rc\n  ⏵⏵ auto mode on · 1 shell, 1 monitor · ← 1 agent\n\n  ● main\n❯ ◯ general-purpose  MR opener - BUG-731 API key revoke fixes    32m 4s · ↑ 75.1k tokens'
# NEGATIVE CONTROL for the same pane shape: a human really IS half-way through
# typing. Anchoring must not buy the false positive back by simply ignoring
# whatever sits below the composer -- real staged text still has to win.
STAGED_WITH_BG_TASK_LIST=$'  … +3 in progress, 19 pending, 42 completed\n──────────────────────────────────────── alice ──\n❯ actually half-typed by a human\n────────────────────────────────────────────────\n  alice │ Sonnet 5 │ ~/agents/alice │ ██░░░░░░░░ 29%    /rc\n\n  ● main\n❯ ◯ general-purpose  MR opener - BUG-731 API key revoke fixes    32m 4s · ↑ 75.1k tokens'
# The raw (-e) capture of that same pane. Claude renders background-task entries
# DIM (ESC[2m) -- the exact marker the Codex rotating-hint check reads as "not
# real text". With the raw lookup left on `tail -1` the dim task entry answered
# for the composer, check_composer_clean returned CLEAN over genuinely staged
# text, and the push would have typed onto a human's half-written line: the same
# root cause as the false skip, failing the dangerous way instead of the safe
# one. The composer line here is bold+highlighted, deliberately NOT dim.
STAGED_WITH_BG_TASK_LIST_RAW=$'  … +3 in progress, 19 pending, 42 completed\n──────────────────────────────────────── alice ──\n\033[1m❯\033[0m\033[48;5;235m actually half-typed by a human\033[0m\n────────────────────────────────────────────────\n  alice │ Sonnet 5 │ ~/agents/alice │ 29%\n\n  ● main\n\033[2m❯ ◯ general-purpose  MR opener - BUG-731 API key revoke fixes    32m 4s\033[0m'

# Agy (Gemini) pane fixtures -- captured live 2026-06-28.
# IDLE: footer "? for shortcuts", bare ">" composer between horizontal rule lines.
# BUSY: braille spinner + "Generating...", footer "esc to cancel". The ">" composer
#       is present in both states -- it is NOT a sole busy discriminator.
AGY_IDLE=$'some transcript\n────────────────────\n1 artifact   /artifact to review\n────────────────────\n>\n────────────────────\n? for shortcuts                  Gemini 3.5 Flash (Medium)'
AGY_BUSY=$'\xe2\xa0\xbf  Generating...\n────────────────────\n>\n────────────────────\nesc to cancel                    Gemini 3.5 Flash (Medium)'
AGY_STAGED=$'some transcript\n────────────────────\n> half-typed agy text\n────────────────────\n? for shortcuts                  Gemini 3.5 Flash (Medium)'

# Codex pane fixtures -- captured live off dana's pane, 2026-07-17.
# IDLE: composer glyph is U+203A (›), never bare, always shows the persistent
#       hint placeholder "Implement {feature}" (stable across many separate
#       idle captures this session) -- check_composer_clean special-cases this
#       one literal as clean. BUSY: "esc to interrupt" (same literal Claude
#       uses), composer resets to the same idle-looking hint line even while busy,
#       so check_idle's whole-pane scan (not the composer line) is what catches it.
CODEX_IDLE=$'some transcript\n\n\xe2\x80\xba Implement {feature}\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'
CODEX_BUSY=$'\xe2\x97\xa6 Working (2s \xe2\x80\xa2 esc to interrupt)\n\n\n\xe2\x80\xba Implement {feature}'
CODEX_STAGED=$'some transcript\n\n\xe2\x80\xba do something real\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'
# Codex ROTATES through several hint placeholders, not just "Implement
# {feature}" -- caught live off dana's pane, 2026-07-18 (reported as "is it a bug
# with tmux keys?" -- no, it was this exact-string allowlist missing a second
# hint, "Run /review on my current changes", so a genuinely-idle pane read as
# staged). Plain -p capture (no ANSI) is indistinguishable from real typed
# text; the -e capture wraps every hint in the ANSI "dim" SGR code (ESC[2m),
# which real user text never has -- that's the general fix's disambiguator.
CODEX_IDLE_ROTATING_HINT=$'some transcript\n\n\xe2\x80\xba Run /review on my current changes\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'
CODEX_IDLE_ROTATING_HINT_RAW=$'some transcript\n\n\033[1m\xe2\x80\xba\033[0m\033[48;5;235m \033[2mRun /review on my current changes\033[0m\033[48;5;235m \n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'

# Codex paste-collapse (2026-07-28, reproduced live off a real Codex pane
# TWICE, both requiring a manual bare-Enter to unstick): send-keys -l of a
# message this long lands in Codex's composer as a collapsed placeholder
# ("[Pasted Content N chars]"), never the literal text, so the retry-Enter
# identity prefix-compare can never match it -- a confirmed-ours message sat
# stuck with no error until a human noticed. MSG below is 26 chars; a
# placeholder reporting a count within a few characters of that must read as
# ours (recovered via char-count, not text-prefix), a count nowhere close
# must not.
CODEX_STAGED_PASTE_OURS=$'some transcript\n\n\xe2\x80\xba [Pasted Content 26 chars]\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'
CODEX_STAGED_PASTE_FOREIGN=$'some transcript\n\n\xe2\x80\xba [Pasted Content 500 chars]\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'

# CODEX BANNER BOX (captured live off dana's pane, 2026-07-29, WITH real staged
# text in the composer -- a genuinely stuck message). This fixture exists because
# of a wrong turn taken while fixing the ❯-task-list bug above: the first attempt
# rule-anchored the RAW (-e) lookup the same way as the plain one, and since SGR
# codes precede the glyph in a raw capture the glyph has to be matched ANYWHERE in
# the line -- which makes every boxed line a candidate. Codex's banner box
# "│ >_ OpenAI Codex (v0.145.0) │" sits directly under a rule and is rendered DIM,
# and dim is exactly what the rotating-hint check reads as "not real text", so
# that version declared dana's genuinely-staged composer CLEAN and would have
# typed onto the stuck message. Caught by diffing old-vs-new verdicts across all
# 13 live panes before commit, not by the suite -- hence this fixture. Must stay
# skip:staged; it goes green-to-red if the raw lookup is ever rule-anchored again.
CODEX_STAGED_BANNER_BOX=$' codex\n╭────────────────────────────╮\n│ >_ OpenAI Codex (v0.145.0) │\n╰────────────────────────────╯\n\n  Tip: Press Tab to queue a message when a task is running\n\n› [Pasted Content 1024 chars] explicit in your review: refetchInterval scoped\n  to "any row still pending", 10-30s range\n\n  gpt-5.6-sol default · ~/agents/dana'
CODEX_STAGED_BANNER_BOX_RAW=$' codex\n\033[2m╭────────────────────────────╮\033[0m\n\033[2m│ >_ \033[0;1mOpenAI Codex\033[0;2m (v0.145.0) │\033[0m\n\033[2m╰────────────────────────────╯\033[0m\n\n  Tip: Press Tab to queue a message when a task is running\n\n\033[1m›\033[0m \033[38;5;6m[Pasted Content 1024 chars]\033[39m explicit in your review: refetchInterval scoped\n  to "any row still pending", 10-30s range\n\n  gpt-5.6-sol default · ~/agents/dana'

# CODEX APPROVAL DIALOG. The pane state that is neither busy nor idle: Codex is
# running nothing and waiting on a human, and the dialog is modal, so the
# composer is not a text field at all. check_idle answers IDLE for it, and IDLE
# is the verdict that licenses the deliver path -- which is text then Enter,
# where Enter is the dialog's CONFIRM key. That is the hazard these cases pin.
#
# PROVENANCE, stated because this suite has been burned twice by imagined
# fixtures (the 26-char paste count above, and the first attempt at the
# capped-paste tail below): this is ONE genuine end-to-end `tmux capture-pane -p`
# of a real Codex approval dialog, no splicing. A real Codex CLI (v0.149.1) was
# run in a scratch tmux session with `--sandbox read-only --ask-for-approval
# on-request`, in a scratch working directory, and asked through its TUI to run
# `touch approval-dialog-test.txt` -- a write, which read-only plus on-request
# must escalate for. It raised exactly this. Driving inbox-push at that live pane
# returned skip:dialog-pending, and a capture taken straight afterwards was
# byte-for-byte identical to the one before, which is what proves no keystroke
# reached the dialog.
#
# NB the older CODEX_APPROVAL_DIALOG fixture near the bottom of this file stays
# where it is: its body is constructed around a verbatim footer and it belongs to
# the check_idle anchoring cases it was written for. This one is the fixture of
# record for dialog DETECTION.
CODEX_DIALOG=$'\xe2\x80\xa2 Running touch approval-dialog-test.txt\n\n\n  Would you like to run the following command?\n\n  Environment: local\n\n  Reason: Allow creating the requested empty file approval-dialog-test.txt in the current directory?\n\n  $ touch approval-dialog-test.txt\n\n\xe2\x80\xba 1. Yes, proceed (y)\n  2. Yes, and don\'t ask again for commands that start with `touch approval-dialog-test.txt` (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel'

# The SAME literal, quoted in the TRANSCRIPT rather than rendered as a live
# dialog, with a clean composer below it: an agent talking about this bug. The
# filler is what makes it a test -- the quote has to fall outside the 20-line
# tail window, which is the only thing separating "a dialog is up" from "somebody
# mentioned one". Without tail-anchoring this pane is refused, and every agent
# discussing dialogs becomes unreachable by live push: the same shape as the
# background-task-list outage the composer anchor was written for.
_DIALOG_QUOTE_FILLER=$(for _i in $(seq 1 24); do printf '  ... transcript line %s of the reply\n' "$_i"; done)
CODEX_DIALOG_QUOTED=$'some transcript\n  I said: the footer is "Press enter to confirm or esc to cancel", which\n  collides with the Gemini busy marker.\n'"$_DIALOG_QUOTE_FILLER"$'\n\xe2\x80\xba Implement {feature}\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'

# Claude's own auto-mode confirmation, for the scope pin. The same Enter hazard,
# a different literal on a different runtime, and deliberately NOT guarded by
# this change: that is a separate fix with its own fixtures and its own live
# capture. The literal is the one entry in the stuck sweep's built-in pattern
# list.
CLAUDE_AUTO_DIALOG=$'  Auto mode classifier requires confirmation\n\n  Bash command\n    rm -rf /tmp/scratch-dir\n\n  Do you want to proceed?\n\xe2\x9d\xaf 1. Yes\n  2. No, and tell Claude what to do differently (esc)'

REC="alice"
MSG="[inbox from courier] hello"

# ---- usage / self ----
( REC=""; MSG=""; run_case "usage: missing args" "usage: inbox-push <recipient> <message>" 1 ); tally $?
( REC="courier"; export PANE_OVERRIDE="$IDLE_CLEAN"; run_case "self: recipient==AGENT_NAME" "skip:self" 2 ); tally $?

# ---- gate branches (PANE_OVERRIDE = pre-send pane) ----
( export PANE_OVERRIDE="$BUSY";        run_case "busy pane -> deliver+queue"  "queued" 0 ); tally $?
( export PANE_OVERRIDE="$COMPACTING";  run_case "compacting pane -> deliver+queue (not false-idle)" "queued" 0 ); tally $?
( export PANE_OVERRIDE="$BUSY_STAGED"; run_case "busy + staged -> skip:staged (gate5 still guards)" "skip:staged" 2 ); tally $?
( export PANE_OVERRIDE="$STAGED_FOREIGN";      run_case "gate: staged composer"     "skip:staged" 2 ); tally $?
( export PANE_OVERRIDE="$NO_COMPOSER"; run_case "gate: no composer (unknown)" "skip:unknown-format" 2 ); tally $?

# ---- dry-run classifier (gates pass, stop before deliver) ----
( export PANE_OVERRIDE="$IDLE_CLEAN" PUSH_DRY_RUN=1; run_case "dry-run: gates pass" "pushed" 0 ); tally $?
# Regression: the real NBSP-resting idle composer must read CLEAN, not staged.
( export PANE_OVERRIDE="$IDLE_CLEAN_NBSP" PUSH_DRY_RUN=1; run_case "dry-run: NBSP idle composer is clean" "pushed" 0 ); tally $?

# ---- verify branches (gate pane idle+clean; PANE_OVERRIDE_2/_3 drive verify) ----
# POST shows busy => Enter landed, agent processing.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$BUSY"
  run_case "verify: post=busy -> pushed" "pushed" 0 ); tally $?

# Busy AT GATE + post shows our text staged => CC has QUEUED it (auto-submits on
# turn end, verified live 2026-06-23). Must report queued + NOT clear it -- the
# old Ctrl-U here was the spurious skip:could-not-submit (us fighting CC's queue).
( export PANE_OVERRIDE="$BUSY" PANE_OVERRIDE_2="$STAGED_FOREIGN"
  run_case "verify: busy-at-gate + post-staged -> queued (don't clear queue)" "queued" 0 ); tally $?

# POST shows clean empty composer => delivered, unconfirmed (nothing staged).
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$IDLE_CLEAN"
  run_case "verify: post=clean -> pushed-unverified" "pushed-unverified" 0 ); tally $?

# A modern busy pane must be seen as BUSY at the gate, so our message is
# reported queued rather than being treated as an idle-pane delivery. Before the
# live-counter branch this fixture read as IDLE, which is what degraded both the
# idle gate and the verify gate.
( export PANE_OVERRIDE="$BUSY_MODERN" PANE_OVERRIDE_2="$STAGED_OURS"
  run_case "gate: modern busy pane (counter only) -> queued, not treated as idle" "queued" 0 ); tally $?

# The two counter forms with NO middot. Both read IDLE before this fix and no
# enumerated literal catches either, so a live pane was poked mid-turn.
( export PANE_OVERRIDE="$BUSY_BARE_SECONDS" PANE_OVERRIDE_2="$STAGED_OURS"
  run_case "gate: busy counter with no middot, seconds only (12s) -> queued" "queued" 0 ); tally $?
( export PANE_OVERRIDE="$BUSY_UNKNOWN_GLYPH" PANE_OVERRIDE_2="$STAGED_OURS"
  run_case "gate: unenumerated spinner glyph + unenumerated word -> queued" "queued" 0 ); tally $?
( export PANE_OVERRIDE="$BUSY_BARE_MINUTES" PANE_OVERRIDE_2="$STAGED_OURS"
  run_case "gate: busy counter with no middot, minutes (1m 26s) -> queued" "queued" 0 ); tally $?

# Negative controls: a FINISHED turn and ordinary prose must stay idle. Without
# these the widening could be made to pass by matching any duration anywhere,
# which would wedge delivery to every idle agent.
( export PANE_OVERRIDE="$DONE_BREWED"
  run_case "gate: completed-turn summary (Brewed for 39s) -> idle, not busy" "pushed-unverified" 0 ); tally $?
( export PANE_OVERRIDE="$DONE_WORKED"
  run_case "gate: completed-turn summary (Worked for 2m 24s) -> idle, not busy" "pushed-unverified" 0 ); tally $?
( export PANE_OVERRIDE="$PROSE_WITH_DURATION"
  run_case "gate: prose containing a duration is NOT a spinner -> idle, not busy" "pushed-unverified" 0 ); tally $?

# POST staged with OUR OWN text, retry, POST2 busy => retry landed.
# The staged text here is the message we just sent, TRUNCATED as the terminal
# renders it: a long push wraps, and check_composer_clean reads only the line
# carrying the prompt glyph, so what we see is a PREFIX of what we sent. This is
# the case the identity check must let through, and the one it would be easy to
# build in a form that never fires.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_OURS" PANE_OVERRIDE_3="$BUSY"
  run_case "verify: staged-OURS->retry->busy -> pushed (identity check allows)" "pushed" 0 ); tally $?

# POST staged with SOMEONE ELSE'S text => never press Enter on it.
# This fixture used to be the case above, asserting that a pane holding
# "half-typed staged text" should receive an Enter. That is the defect: the
# branch's comment claimed the staged text was ours, and check_composer_clean
# only ever answered "is there text". If a human had begun typing during the
# ~1.6s window, inbox-push would have submitted his half-written line believing
# it was completing its own delivery. The suite asserted that as correct.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_FOREIGN" PANE_OVERRIDE_3="$BUSY"
  run_case "verify: staged-FOREIGN -> no retry -> pushed-unverified (identity check blocks)" "pushed-unverified" 0 ); tally $?

# POST staged, retry, POST2 clean => retry cleared it.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_FOREIGN" PANE_OVERRIDE_3="$IDLE_CLEAN"
  run_case "verify: staged->retry->clean -> unverified" "pushed-unverified" 0 ); tally $?

# POST staged, retry, POST2 still staged => LEAVE it (do NOT Ctrl-U: could be a
# CC-queued message on a pane whose busy state check_idle missed). Delivered-unverified.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_FOREIGN" PANE_OVERRIDE_3="$STAGED_FOREIGN"
  run_case "verify: staged x2 -> pushed-unverified (no clear, leave it)" "pushed-unverified" 0 ); tally $?

# ---- runtime gate (RUNTIME_OVERRIDE drives the gate in test mode) ----
# claude runtime passes through.
( export PANE_OVERRIDE="$IDLE_CLEAN" RUNTIME_OVERRIDE="claude" PUSH_DRY_RUN=1
  run_case "runtime: claude explicit -> passes gate" "pushed" 0 ); tally $?
# agy runtime passes through.
( export PANE_OVERRIDE="$AGY_IDLE" RUNTIME_OVERRIDE="agy" PUSH_DRY_RUN=1
  run_case "runtime: agy explicit -> passes gate" "pushed" 0 ); tally $?
# codex runtime passes through.
( export PANE_OVERRIDE="$CODEX_IDLE" RUNTIME_OVERRIDE="codex" PUSH_DRY_RUN=1
  run_case "runtime: codex explicit -> passes gate" "pushed" 0 ); tally $?
# Unknown/other runtime is skipped.
( export PANE_OVERRIDE="$IDLE_CLEAN" RUNTIME_OVERRIDE="gemini-cli"
  run_case "runtime: other unknown -> skip:unknown-runtime" "skip:unknown-runtime" 2 ); tally $?
( export PANE_OVERRIDE="$IDLE_CLEAN" RUNTIME_OVERRIDE=""
  run_case "runtime: empty string -> skip:unknown-runtime" "skip:unknown-runtime" 2 ); tally $?

# AGENTS_HOME is honoured for the runtime lookup. The gate reads
# "$AGENTS_HOME/<recipient>/.runtime", so a deployment whose agent homes are not
# under ~/agents must still be gated off its own files. Every case above drives the
# gate through RUNTIME_OVERRIDE, which is a TEST-MODE seam and never opens the file,
# so none of them touches the path at all.
#
# This case therefore runs with PANE_OVERRIDE UNSET (TEST_MODE=0, the only mode in
# which the file is read), which means tmux has to answer. A stub `tmux` first on
# PATH answers the window probe and the capture calls, so no tmux server is
# contacted, and PUSH_DRY_RUN stops the flow before any send-keys exists to send.
# If AGENTS_HOME were ignored the file would not be found, _RUNTIME would be empty
# and the verdict would be skip:unknown-runtime -- so "pushed" is a positive
# assertion that the var, not a hardcoded home, located the file.
(
  _AH_TMP="$(mktemp -d)"
  trap 'rm -rf "$_AH_TMP"' EXIT
  mkdir -p "$_AH_TMP/homes/$REC" "$_AH_TMP/stub"
  printf 'claude\n' > "$_AH_TMP/homes/$REC/.runtime"
  cat > "$_AH_TMP/stub/tmux" <<'STUB'
#!/usr/bin/env bash
# Stub tmux for the AGENTS_HOME case: answers the window probe with the recipient
# and both capture-pane forms with the injected pane text. Anything else is a no-op.
case "$1" in
  list-windows) printf '%s\n' "$STUB_TMUX_WINDOW" ;;
  capture-pane) printf '%s' "$STUB_TMUX_PANE" ;;
  *) : ;;
esac
STUB
  chmod +x "$_AH_TMP/stub/tmux"
  export STUB_TMUX_WINDOW="$REC" STUB_TMUX_PANE="$IDLE_CLEAN"
  export AGENTS_HOME="$_AH_TMP/homes" PATH="$_AH_TMP/stub:$PATH" PUSH_DRY_RUN=1
  run_case "AGENTS_HOME: temp-home .runtime drives the gate" "pushed" 0
); tally $?

# ---- agy pane gate + verify branches ----
# (a) Agy idle pane -> gates pass -> message delivered -> positive verify.
( export PANE_OVERRIDE="$AGY_IDLE" PANE_OVERRIDE_2="$AGY_BUSY" RUNTIME_OVERRIDE="agy"
  run_case "agy: idle pane + verify-busy -> pushed" "pushed" 0 ); tally $?
# (a2) Agy idle pane, verify also idle -> pushed-unverified (nothing staged).
( export PANE_OVERRIDE="$AGY_IDLE" PANE_OVERRIDE_2="$AGY_IDLE" RUNTIME_OVERRIDE="agy"
  run_case "agy: idle pane + verify-idle -> pushed-unverified" "pushed-unverified" 0 ); tally $?
# (a3) Dry-run confirms agy idle pane reads clean (bare ">" is clean, not staged).
( export PANE_OVERRIDE="$AGY_IDLE" RUNTIME_OVERRIDE="agy" PUSH_DRY_RUN=1
  run_case "agy: dry-run idle pane -> pushed (bare > is clean)" "pushed" 0 ); tally $?
# (b) Agy busy pane at gate -> deliver+queue.
( export PANE_OVERRIDE="$AGY_BUSY" PANE_OVERRIDE_2="$AGY_BUSY" RUNTIME_OVERRIDE="agy"
  run_case "agy: busy pane -> queued" "queued" 0 ); tally $?
# (c) Agy staged composer -> skip:staged (gate guards dirty composer on any runtime).
( export PANE_OVERRIDE="$AGY_STAGED" RUNTIME_OVERRIDE="agy"
  run_case "agy: staged composer -> skip:staged" "skip:staged" 2 ); tally $?

# ---- codex pane gate + verify branches ----
# (a) Codex idle pane -> gates pass -> message delivered -> positive verify.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_BUSY" RUNTIME_OVERRIDE="codex"
  run_case "codex: idle pane + verify-busy -> pushed" "pushed" 0 ); tally $?
# (a2) Codex idle pane, verify also idle -> pushed-unverified (nothing staged).
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_IDLE" RUNTIME_OVERRIDE="codex"
  run_case "codex: idle pane + verify-idle -> pushed-unverified" "pushed-unverified" 0 ); tally $?
# (a3) Dry-run confirms the persistent "Implement {feature}" hint reads clean, not staged.
( export PANE_OVERRIDE="$CODEX_IDLE" RUNTIME_OVERRIDE="codex" PUSH_DRY_RUN=1
  run_case "codex: dry-run idle pane -> pushed (hint placeholder is clean)" "pushed" 0 ); tally $?
# (b) Codex busy pane at gate -> deliver+queue.
( export PANE_OVERRIDE="$CODEX_BUSY" PANE_OVERRIDE_2="$CODEX_BUSY" RUNTIME_OVERRIDE="codex"
  run_case "codex: busy pane -> queued" "queued" 0 ); tally $?
# (c) Codex REAL staged text (not the hint) -> skip:staged.
( export PANE_OVERRIDE="$CODEX_STAGED" RUNTIME_OVERRIDE="codex"
  run_case "codex: staged composer -> skip:staged" "skip:staged" 2 ); tally $?
# (d) A SECOND rotating hint (not the hardcoded literal), with the matching
# ANSI-dim raw capture supplied -> the general dim-check catches it as clean.
( export PANE_OVERRIDE="$CODEX_IDLE_ROTATING_HINT" PANE_RAW_OVERRIDE="$CODEX_IDLE_ROTATING_HINT_RAW" \
         RUNTIME_OVERRIDE="codex" PUSH_DRY_RUN=1
  run_case "codex: dry-run, rotating hint + raw dim capture -> pushed" "pushed" 0 ); tally $?
# (e) Same rotating hint, but NO raw capture available (documents why the
# raw capture is load-bearing -- without it, an unrecognised hint still
# false-skips, same failure mode as the original bug).
( export PANE_OVERRIDE="$CODEX_IDLE_ROTATING_HINT" RUNTIME_OVERRIDE="codex"
  run_case "codex: rotating hint, no raw capture -> skip:staged (fallback limit)" "skip:staged" 2 ); tally $?

# ---- codex paste-collapse (the paste-collapse fix) ----
# (f) Idle at gate, our own text lands as a paste-collapse placeholder whose
# char count matches what we sent -> the count-based identity check confirms
# it is ours, retries Enter, POST2 busy -> pushed. This is the exact bug: the
# prefix compare alone can never match a placeholder, only the count can.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_OURS" PANE_OVERRIDE_3="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: idle + paste-collapse OURS -> retry -> pushed" "pushed" 0 ); tally $?
# (g) Idle at gate, a paste-collapse placeholder with a WILDLY different char
# count -> not ours, no retry, no Enter pressed on it -> pushed-unverified.
# Proves the count check still protects against a genuinely foreign paste
# (e.g. a human pasting something else into that pane), it does not just accept
# every placeholder unconditionally.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_FOREIGN" PANE_OVERRIDE_3="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: idle + paste-collapse FOREIGN count -> no retry -> pushed-unverified" "pushed-unverified" 0 ); tally $?
# (h) BUSY at gate, but by verify time the turn has ended (POST not busy) and
# our text sits as a paste-collapse placeholder -> Codex does NOT get the
# claude-only trust-the-queue shortcut, falls through to the same
# identify-and-retry logic, retries, POST2 busy -> pushed. Before this fix
# this case emitted "queued" (success) while the message sat stuck forever,
# because the queue-and-autosubmit assumption is verified for Claude only.
( export PANE_OVERRIDE="$CODEX_BUSY" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_OURS" PANE_OVERRIDE_3="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: busy-at-gate + turn-ended-but-stuck -> retry -> pushed (not blind queued)" "pushed" 0 ); tally $?
# (i) Regression: the SAME busy-at-gate + staged-but-not-ours shape for
# CLAUDE must still take the trust-the-queue shortcut unchanged -- this fix
# is Codex-only. RUNTIME_OVERRIDE unset (claude gate default, matches the
# pre-existing "verify: busy-at-gate + post-staged -> queued" case above) so
# _RUNTIME is empty, not "codex".
( export PANE_OVERRIDE="$BUSY" PANE_OVERRIDE_2="$STAGED_FOREIGN"
  run_case "claude: busy-at-gate + post-staged -> still queued (codex-only change)" "queued" 0 ); tally $?

# ---- claude background-task list below the composer (2026-07-29) ----
# THE BUG. An idle pane with an empty composer and a visible subagent's task
# entry below it must read clean and push. Before the rule-anchoring fix this
# returned skip:staged and kept returning it for as long as the subagent was
# visible, so the agent was simply unreachable by live push.
( export PANE_OVERRIDE="$IDLE_WITH_BG_TASK_LIST_BELOW_COMPOSER" RUNTIME_OVERRIDE="claude" PUSH_DRY_RUN=1
  run_case "bg-task list below composer -> clean, not staged" "pushed" 0 ); tally $?
# Same pane through the full flow (not just the classifier): verify sees a new
# turn start, so this reports a positive push rather than a skip.
( export PANE_OVERRIDE="$IDLE_WITH_BG_TASK_LIST_BELOW_COMPOSER" PANE_OVERRIDE_2="$BUSY" RUNTIME_OVERRIDE="claude"
  run_case "bg-task list below composer -> pushed" "pushed" 0 ); tally $?
# NEGATIVE: real staged text with the same task entry below it -> still skipped.
( export PANE_OVERRIDE="$STAGED_WITH_BG_TASK_LIST" RUNTIME_OVERRIDE="claude"
  run_case "bg-task list + REAL staged text -> skip:staged" "skip:staged" 2 ); tally $?
# NEGATIVE on the dim-hint path: a DIM task entry in the raw capture must not
# answer for the composer and declare a genuinely staged pane clean.
( export PANE_OVERRIDE="$STAGED_WITH_BG_TASK_LIST" PANE_RAW_OVERRIDE="$STAGED_WITH_BG_TASK_LIST_RAW" \
         RUNTIME_OVERRIDE="claude"
  run_case "bg-task list DIM in raw + staged -> skip:staged" "skip:staged" 2 ); tally $?
# The mirror hazard on the OTHER runtime, found live on dana: Codex's DIM banner
# box also sits under a rule, so a rule-anchored raw lookup reads it as the
# composer and its dimness declares a genuinely stuck message clean.
( export PANE_OVERRIDE="$CODEX_STAGED_BANNER_BOX" PANE_RAW_OVERRIDE="$CODEX_STAGED_BANNER_BOX_RAW" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex banner box + staged text -> skip:staged" "skip:staged" 2 ); tally $?

# ---- codex third Enter (2026-07-29 live incident) ----
# THE INCIDENT SHAPE. A real DM to dana: our paste-collapsed text staged in his
# composer, Enter #1 did not register, Enter #2 did not register either, and it
# sat genuinely unsubmitted for ~46 minutes until a human pressed Enter a third
# time by hand. Before this fix the script gave up after two and reported
# "pushed-unverified" -- true, but one keypress short of delivering. POST2 still
# staged, POST3 busy => the third attempt lands => pushed.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_OURS" \
         PANE_OVERRIDE_3="$CODEX_STAGED_PASTE_OURS" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: two Enters fail, THIRD lands -> pushed" "pushed" 0 ); tally $?

# The ceiling holds. All three attempts fail => the EXISTING safe give-up, not a
# fourth try and not a clear. PANE_OVERRIDE_4 is still staged, so if any further
# retry existed it would have to invent a fifth pane state to succeed on; the
# verdict here is the same one the two-try script produced, which is the point.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_OURS" \
         PANE_OVERRIDE_3="$CODEX_STAGED_PASTE_OURS" PANE_OVERRIDE_4="$CODEX_STAGED_PASTE_OURS" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: all THREE fail -> pushed-unverified (no clear)" "pushed-unverified" 0 ); tally $?

# The same shape via the busy-at-gate door (the paste-collapse fix made Codex fall through
# the trust-the-queue shortcut into this same retry logic) -- the third attempt
# must be reachable from there too, not only from an idle-at-gate send.
( export PANE_OVERRIDE="$CODEX_BUSY" PANE_OVERRIDE_2="$CODEX_STAGED_PASTE_OURS" \
         PANE_OVERRIDE_3="$CODEX_STAGED_PASTE_OURS" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: busy-at-gate, two fail, THIRD lands -> pushed" "pushed" 0 ); tally $?

# GATED OFF for every non-codex runtime. Each of these scripts PANE_OVERRIDE_4 as
# BUSY -- i.e. a third Enter, if one were sent, would be observed as landing and
# would emit "pushed". Expecting "pushed-unverified" is therefore a positive
# assertion that no third Enter and no fourth capture happened, not just that the
# verdict looks unchanged.
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_OURS" \
         PANE_OVERRIDE_3="$STAGED_OURS" PANE_OVERRIDE_4="$BUSY" RUNTIME_OVERRIDE="claude"
  run_case "claude: two Enters fail -> NO third attempt" "pushed-unverified" 0 ); tally $?
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_OURS" \
         PANE_OVERRIDE_3="$STAGED_OURS" PANE_OVERRIDE_4="$BUSY" RUNTIME_OVERRIDE="agy"
  run_case "agy: two Enters fail -> NO third attempt" "pushed-unverified" 0 ); tally $?
( export PANE_OVERRIDE="$IDLE_CLEAN" PANE_OVERRIDE_2="$STAGED_OURS" \
         PANE_OVERRIDE_3="$STAGED_OURS" PANE_OVERRIDE_4="$BUSY"
  run_case "runtime unset: two Enters fail -> NO third attempt" "pushed-unverified" 0 ); tally $?

# ---- codex approval dialog (2026-09) --------------------------------------
# THE HAZARD. A pane wedged on an UNANSWERED Codex approval dialog is running
# nothing and waiting on a human, so check_idle answers IDLE -- and IDLE is what
# sends this script down the deliver path. Deliver is text + Enter, and Enter is
# the dialog's CONFIRM key, so the push answers a permission prompt Codex
# deliberately stopped to ask about, unattended and in the yes direction.
#
# BE HONEST ABOUT WHAT EACH CASE PROVES, because these two guards are not
# equally observable from a verdict.
#   - T1 (the pre-send gate) IS red-green here: measured against the pre-change
#     script, this exact fixture gave skip:staged, and it now gives
#     skip:dialog-pending.
#   - T2 (the post-send guard) is NOT, measured the same way: that case already
#     emitted pushed-unverified before the change, because find_composer_line
#     lands on the marked selected OPTION line and the identity check then
#     refuses to press Enter at text that is not ours. That is one glyph doing
#     double duty, not a guard -- it knows nothing about dialogs and evaporates
#     the moment Codex renders its selection differently -- so T2 pins the
#     verdict rather than proving the guard. The guard shows up in a verdict at
#     T4(c) (codex answers pushed-unverified where claude answers queued), and
#     its PLACEMENT, which is the part a verdict cannot see at all, is pinned by
#     the structural case at the end of this section.

# T1. Dialog up at the gate -> named refusal, nothing typed. The assertion is
# the REASON as much as the outcome: the refusal is now deliberate rather than
# an accident of glyph reuse.
( export PANE_OVERRIDE="$CODEX_DIALOG" RUNTIME_OVERRIDE="codex"
  run_case "codex: dialog at gate -> skip:dialog-pending" "skip:dialog-pending" 2 ); tally $?
# ...and it is a GATE, upstream of the dry-run classifier's stop, so the
# classifier reports the refusal too rather than "would push".
( export PANE_OVERRIDE="$CODEX_DIALOG" RUNTIME_OVERRIDE="codex" PUSH_DRY_RUN=1
  run_case "codex: dry-run reports dialog-pending, not pushed" "skip:dialog-pending" 2 ); tally $?

# T2. Busy at the gate (a real turn was running), and by the post-send capture
# that turn has raised an approval dialog -- so our text and our Enter arrived at
# a modal. PANE_OVERRIDE_3/_4 are BUSY on purpose: any Enter after this point
# would be observed landing and would emit "pushed", so "pushed-unverified" is a
# positive assertion that no further keystroke was sent at the dialog (the same
# trick as the third-Enter cases above).
( export PANE_OVERRIDE="$CODEX_BUSY" PANE_OVERRIDE_2="$CODEX_DIALOG" \
         PANE_OVERRIDE_3="$CODEX_BUSY" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: dialog on POST -> pushed-unverified, no Enter #2" "pushed-unverified" 0 ); tally $?

# T3 is the EXISTING "codex: busy pane -> queued" case above, and it must stay
# green UNMODIFIED. That is the design decision this change rests on: a message
# queued behind a genuinely busy Codex turn does auto-submit when the turn ends,
# so the categorical "exempt codex from queued" shape was rejected. Only the
# dialog shape is carved out.

# T4. SCOPE. Codex-only, both guards.
# (a) Claude's own auto-mode confirmation carries the identical Enter hazard and
#     is deliberately NOT guarded here. Unchanged behaviour, pinned so that the
#     day it is taken on, the change is visible.
( export PANE_OVERRIDE="$CLAUDE_AUTO_DIALOG" RUNTIME_OVERRIDE="claude"
  run_case "claude: auto-mode dialog -> unchanged (skip:staged)" "skip:staged" 2 ); tally $?
# (b) The sharper pin, and the one that is genuinely discriminating: the CODEX
#     dialog fixture on a CLAUDE-runtime pane must not take the new gate. Same
#     bytes, different runtime, different reason -- so this fails if the guard is
#     ever written runtime-blind.
( export PANE_OVERRIDE="$CODEX_DIALOG" RUNTIME_OVERRIDE="claude"
  run_case "claude runtime + codex dialog bytes -> not dialog-pending" "skip:staged" 2 ); tally $?
# (c) ...and the POST guard is runtime-scoped too: the same POST dialog on a
#     claude pane still reports queued, unchanged. This one IS discriminating,
#     and it is the only place the post-send guard shows up in a verdict: the
#     codex case above answers pushed-unverified where this answers queued.
( export PANE_OVERRIDE="$CODEX_BUSY" PANE_OVERRIDE_2="$CODEX_DIALOG" \
         PANE_OVERRIDE_3="$CODEX_BUSY" RUNTIME_OVERRIDE="claude"
  run_case "claude: dialog on POST -> still queued (codex-only)" "queued" 0 ); tally $?

# T5. TAIL-ANCHORING. An agent whose transcript merely QUOTES the footer, with a
# clean composer, must still be reachable. A whole-pane substring test would
# refuse every push to whoever is discussing this bug, silently, for as long as
# the quote stayed on screen.
( export PANE_OVERRIDE="$CODEX_DIALOG_QUOTED" RUNTIME_OVERRIDE="codex" PUSH_DRY_RUN=1
  run_case "codex: footer quoted high in transcript -> gates pass" "pushed" 0 ); tally $?
# Same pane through the full flow: idle at the gate, busy after the send, so the
# Enter started a new turn. It DELIVERS rather than being refused by the gate.
( export PANE_OVERRIDE="$CODEX_DIALOG_QUOTED" PANE_OVERRIDE_2="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex"
  run_case "codex: quoted footer still delivers" "pushed" 0 ); tally $?

# STRUCTURAL, and this is the real pin for the post-send guard (see the honesty
# note at the top of this section). It must sit ABOVE the check_idle branch that
# classifies the post-send capture, never inside it. Inside, the guard would fire
# only while a dialog pane happened to read BUSY -- a classification that has
# already moved once, and that this guard exists precisely to distrust. A verdict
# test cannot see the difference; a line-order test can.
_guard_ln=$(grep -nF 'pane_has_codex_approval_dialog "$POST"' "$PUSH" | head -1 | cut -d: -f1)
_branch_ln=$(grep -nF 'if check_idle "$POST"; then' "$PUSH" | head -1 | cut -d: -f1)
if [ -n "$_guard_ln" ] && [ -n "$_branch_ln" ] && [ "$_guard_ln" -lt "$_branch_ln" ]; then
  printf 'PASS  %-42s -> %s\n' "structural: POST dialog guard precedes check_idle" \
    "guard L$_guard_ln, branch L$_branch_ln"; tally 0
else
  printf 'FAIL  %-42s -> %s\n' "structural: POST dialog guard precedes check_idle" \
    "guard '${_guard_ln:-missing}', branch '${_branch_ln:-missing}'"; tally 1
fi

# ---------------------------------------------------------------------------
# THE CAPPED PASTE (the capped-placeholder fix). Why every codex case above passed while the
# feature was dead in production.
#
# MSG is 26 characters and CODEX_STAGED_PASTE_OURS says "26 chars", so the count
# compare confirms identity and the whole retry path runs. But a 26-character
# message NEVER COLLAPSES INTO A PASTE IN THE FIRST PLACE. Every codex case
# above pins a scenario that cannot occur, which is how the suite stayed 57/57
# green on a live file that stranded four consecutive real messages.
#
# Measured live 2026-08-12: real messages of 1234, 1795, 2142 and 4072 chars ALL
# rendered as "[Pasted Content 1024 chars]". The number is a CEILING wearing the
# costume of a measurement, so paste_diff is the overshoot and never <= 3. And
# `emit` calls exit, so the not-ours branch terminated the script before Enter
# #1 -- the third-Enter feature was unreachable, not merely unused.
#
# The fixtures below are the production shape: a capped count AND the visible
# tail Codex renders after the placeholder.
MSG_LONG="[inbox from courier] $(printf 'the quick brown fox jumps over the lazy dog %.0s' $(seq 1 30))and this is how it ends"
# COPIED FROM A REAL PANE, not imagined. Two details that a hand-built fixture
# gets wrong, and both of which defeated the first attempt at this fix:
#   1. There is NO SPACE after "chars]" -- the remainder runs straight on.
#   2. The remainder begins at message offset 1024, so it starts MID-WORD, and
#      the last prompt line holds only the START of it (the rest wraps below,
#      where check_composer_clean cannot see it).
# So the identifiable text is a mid-message WINDOW, never the tail. Building
# this from an assumption instead of a capture is exactly the mistake that let
# the 26-char fixture above stay green while the feature was dead.
_REMAINDER="${MSG_LONG:1024}"
_VISIBLE="${_REMAINDER:0:49}"
CODEX_PASTE_CAPPED_OURS=$'some transcript\n\n\xe2\x80\xba [Pasted Content 1024 chars]'"$_VISIBLE"$'\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'
CODEX_PASTE_CAPPED_FOREIGN=$'some transcript\n\n\xe2\x80\xba [Pasted Content 1024 chars]and this is somebody elses entirely different paste\n\n  gpt-5.6-sol default \xc2\xb7 ~/agents/dana'

# THE BUG, AS A DELIVERY. Deliberately asserts "pushed", not a code path: the
# guard this backs up was itself "permanently inert, safe, and indistinguishable
# from working", so a test proving only that a branch was entered would repeat
# the mistake. PANE_OVERRIDE_4 busy => the third Enter landed => delivered,
# which is the only thing the sender cares about.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_PASTE_CAPPED_OURS" \
         PANE_OVERRIDE_3="$CODEX_PASTE_CAPPED_OURS" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex" MSG="$MSG_LONG"
  run_case "codex: CAPPED paste is still ours -> delivered" "pushed" 0 ); tally $?

# Same fixture, retries all failing: identity must still be recovered, so the
# verdict is the honest give-up rather than the silent pre-Enter exit the cap
# used to cause. Same words, different meaning, which is the point.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_PASTE_CAPPED_OURS" \
         PANE_OVERRIDE_3="$CODEX_PASTE_CAPPED_OURS" PANE_OVERRIDE_4="$CODEX_PASTE_CAPPED_OURS" \
         RUNTIME_OVERRIDE="codex" MSG="$MSG_LONG"
  run_case "codex: capped paste, all three fail -> give up" "pushed-unverified" 0 ); tally $?

# THE SAFETY HALF, and it is why the tail test is a SUFFIX MATCH rather than
# "a placeholder is present". A capped placeholder whose tail is not ours must
# still refuse to press Enter. Without this the fix would trade a stranded
# message for submitting somebody else's composer, which is the worse bug.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_PASTE_CAPPED_FOREIGN" \
         PANE_OVERRIDE_3="$CODEX_BUSY" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="codex" MSG="$MSG_LONG"
  run_case "codex: capped paste, NOT ours -> never Enter" "pushed-unverified" 0 ); tally $?

# The tail route is codex-only, like the count route it backs up. PANE_OVERRIDE_4
# is BUSY, so a third Enter, if one were sent, would be observed as landing and
# would emit "pushed" -- making this a positive assertion that none was sent.
( export PANE_OVERRIDE="$CODEX_IDLE" PANE_OVERRIDE_2="$CODEX_PASTE_CAPPED_OURS" \
         PANE_OVERRIDE_3="$CODEX_PASTE_CAPPED_OURS" PANE_OVERRIDE_4="$CODEX_BUSY" \
         RUNTIME_OVERRIDE="claude" MSG="$MSG_LONG"
  run_case "claude: capped paste gets no third Enter" "pushed-unverified" 0 ); tally $?

# STRUCTURAL. The two properties the verdict tests above cannot observe, because
# send-keys is suppressed in test mode: what keys exist in the script at all.
# (1) Ctrl-U is never sent -- clearing a composer can destroy a genuinely-queued
#     message (standing rule, 2026-06-23), and the third-Enter change must not have
#     smuggled a clear back in as a "recovery".
if grep -qE 'send-keys.*C-[uU]' "$PUSH"; then
  printf 'FAIL  %-42s -> a C-u send-keys exists in inbox-push\n' "structural: no Ctrl-U anywhere"; tally 1
else
  printf 'PASS  %-42s -> none\n' "structural: no Ctrl-U anywhere"; tally 0
fi
# (2) Exactly THREE Enter keypresses exist in the whole script (deliver + retry
#     + the codex third). This pins the ceiling as a test rather than a comment:
#     a fourth attempt, or a retry loop built out of the same call, fails here.
_enters=$(grep -cE '^[[:space:]]*tx send-keys .* Enter$' "$PUSH")
if [ "$_enters" = "3" ]; then
  printf 'PASS  %-42s -> %s\n' "structural: exactly 3 Enter sends" "$_enters"; tally 0
else
  printf 'FAIL  %-42s -> %s (want 3)\n' "structural: exactly 3 Enter sends" "$_enters"; tally 1
fi

echo "-----------------------------------------------"
# ---- context gate (2026-08) ---------------------------------------------
# NB the delivered cases assert "pushed-unverified", not "pushed": these fixtures set
# no post-send capture, so the harness cannot confirm the composer cleared. The
# distinction this gate is about is DELIVERED (rc=0) vs BLOCKED (skip:ctx-over, rc=2).
# Stop pushing at an agent that is nearly full, so it is not kept too busy to compact.
( export PANE_OVERRIDE="$IDLE_CTX_92"; run_case "ctx gate: 92% blocks the push" "skip:ctx-over" 2 ); tally $?
( export PANE_OVERRIDE="$IDLE_CTX_ALT"; run_case "ctx gate: ctx:NN% format blocks too" "skip:ctx-over" 2 ); tally $?
# Boundary: 80 is "at" the block, not under it.
( export PANE_OVERRIDE="$IDLE_CTX_80"; run_case "ctx gate: blocks AT the threshold" "skip:ctx-over" 2 ); tally $?
( export PANE_OVERRIDE="$IDLE_CTX_46"; run_case "ctx gate: under threshold delivers" "pushed-unverified" 0 ); tally $?

# THE CARVE-OUT. Handover and compaction messages must always get through, or the
# gate blocks the only message that resolves the condition it gates on.
( export PANE_OVERRIDE="$IDLE_CTX_92" INBOX_PUSH_ALLOW_CTX_OVER=1
  run_case "ctx gate: compaction/handover exempt at 92%" "pushed-unverified" 0 ); tally $?

# Configurable + disableable, so it can be tuned or switched off live without a revert.
( export PANE_OVERRIDE="$IDLE_CTX_46" INBOX_PUSH_CTX_BLOCK=40
  run_case "ctx gate: threshold is configurable" "skip:ctx-over" 2 ); tally $?
( export PANE_OVERRIDE="$IDLE_CTX_92" INBOX_PUSH_CTX_BLOCK=off
  run_case "ctx gate: off disables it entirely" "pushed-unverified" 0 ); tally $?

# FAILS OPEN on an unreadable ctx%, deliberately. This gate is a protective throttle,
# not a safety gate: failing open restores today's behaviour, failing closed strands
# every message fleet-wide the moment a statusline changes.
( export PANE_OVERRIDE="$IDLE_CLEAN"; run_case "ctx gate: unreadable ctx delivers (fail-open)" "pushed-unverified" 0 ); tally $?

echo "-----------------------------------------------"
# ===========================================================================
# check_idle: "esc to cancel" must LEAD ITS CLAUSE  (2026-08-21)
# ===========================================================================
# THE INCIDENT. Codex renders an approval dialog whose footer reads "Press
# enter to confirm or esc to cancel" -- captured live off a real pane. The
# Gemini busy marker in bin/pane-idle was a BARE SUBSTRING match on "esc to
# cancel", so it fired on that footer too, and a pane sitting on an UNANSWERED
# confirmation dialog reported BUSY. That pane is stuck waiting on a human, and
# every caller that asks "is this busy?" before escalating skipped it in
# silence: one agent sat that way for over two hours before somebody noticed.
#
# THE FIX is positional, not an enumerated wording: the phrase counts as a busy
# marker only when it opens its own line (a footer, indented or not) or sits
# directly after "(" as an inline hint. That is the same structural style as
# the end-of-line counter rule -- see the extensive history in bin/pane-idle
# for why every enumerated variant of this file has eventually gone blind.
#
# These cases assert check_idle DIRECTLY, by sourcing the library, because the
# verdict they are about is not observable through inbox-push (see the
# end-to-end case at the bottom of this section for why). They live in this
# suite rather than a pane-idle.test.sh of their own only because that filename
# is already claimed by work in flight; moving them is a follow-up, and
# colliding on the name now would cost a merge conflict for nothing.
PANE_IDLE_LIB="${PANE_IDLE_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)/pane-idle}"
# shellcheck source=../bin/pane-idle
. "$PANE_IDLE_LIB" 2>/dev/null
if [ -z "${PANE_IDLE_LIB_VERSION:-}" ]; then
  # Assert the load rather than trusting that `.` succeeded: an undefined
  # check_idle is "command not found" -> non-zero -> reads as IDLE, so every
  # busy expectation below would fail LOUDLY but every idle one would pass for
  # the wrong reason. Stop instead.
  printf 'FAIL  %-42s -> %s\n' "check_idle: library sourced" "$PANE_IDLE_LIB"; tally 1
  echo "inbox-push: $PASS passed, $((FAIL)) failed"
  exit 1
fi

# idle_case <name> <pane> <busy|idle> -- assert check_idle's verdict directly.
# Runs in THIS shell (not an isolation subshell) so it tallies inline; there is
# no process to isolate, only a function call.
idle_case() {
  local name="$1" pane="$2" want="$3" got
  if check_idle "$pane"; then got=busy; else got=idle; fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-42s -> %s\n' "$name" "$got"; tally 0
  else
    printf 'FAIL  %-42s -> got %s, want %s\n' "$name" "$got" "$want"; tally 1
  fi
}

# Gemini's REAL busy footer, reusing the live-captured fixture above: the phrase
# opens the footer line, so it still reads BUSY. The core regression guard --
# the narrowing exists to spare Codex, and must cost Gemini nothing.
idle_case "agy: real busy footer still reads busy" "$AGY_BUSY" busy
# ...and the same footer with the phase word swapped out. AGY_BUSY carries TWO
# independent busy markers ("Generating" and the footer), so on its own it
# cannot tell us which one answered: delete the esc-to-cancel branch entirely
# and it stays green. Derived from AGY_BUSY by substitution rather than retyped,
# so it cannot drift away from the fixture it is meant to isolate.
AGY_BUSY_ALT_PHASE="${AGY_BUSY/Generating/Composing}"
idle_case "agy: busy footer alone carries the verdict" "$AGY_BUSY_ALT_PHASE" busy
# The hint rendered INLINE in parens rather than as its own footer line. SYNTHESIZED,
# not a live capture: a plausible alternate/future Gemini rendering, flagged as such
# per this suite's convention of being honest about fixture provenance. It exists to
# pin the paren half of the anchor, which no captured fixture currently exercises --
# and it can only pass through that branch: the glyph is outside the spinner class
# and the parenthesised text does not open with a digit, so the counter rule cannot
# answer for it either.
AGY_BUSY_INLINE_HINT=$'\xe2\x9c\xa6 Cranking... (esc to cancel, 12s)\n────────────────────\n>\n────────────────────\n? for shortcuts                  Gemini 3.5 Flash (Medium)'
idle_case "agy: inline (esc to cancel, 12s) hint -> busy" "$AGY_BUSY_INLINE_HINT" busy
# THE BUG. The footer is VERBATIM from the live capture; the dialog body around
# it is constructed, not captured -- only the footer line survived the incident
# report, and inventing a "live capture" would be the exact mistake the
# capped-paste fixture above was written to correct.
CODEX_APPROVAL_DIALOG=$'some transcript\n\n  Codex wants to run:\n\n    rm -rf build/\n\n\xe2\x80\xba 1. Yes, run it\n  2. No, and tell Codex what to do differently\n\n  Press enter to confirm or esc to cancel'
idle_case "codex: unanswered approval dialog -> idle" "$CODEX_APPROVAL_DIALOG" idle
# And ordinary prose quoting the phrase mid-sentence, over an idle composer.
# Panes are full of message text -- this is the same false-positive class the
# counter rule is anchored against -- and it locks the narrowing against being
# quietly widened back to a bare substring later.
PROSE_QUOTING_CANCEL=$'  I read the capture back: the footer said or esc to cancel, mid-sentence\n────────────────────\n>\n────────────────────\n? for shortcuts                  Gemini 3.5 Flash (Medium)'
idle_case "prose quoting the phrase mid-sentence -> idle" "$PROSE_QUOTING_CANCEL" idle
# The existing agy fixtures, at the check_idle level rather than through the
# push flow: neither carries a busy marker and neither may acquire one.
idle_case "agy: idle pane -> idle" "$AGY_IDLE" idle
idle_case "agy: staged pane is not busy" "$AGY_STAGED" idle

# THE FIXTURE IS ONLY A REGRESSION TEST IF IT USED TO FAIL. Assert that
# directly: the bare substring the fix replaced really does find the phrase in
# this dialog. Without this, CODEX_APPROVAL_DIALOG could be quietly edited into
# something that never collided and the case above would keep passing while
# proving nothing.
if printf '%s' "$CODEX_APPROVAL_DIALOG" | grep -qF 'esc to cancel'; then
  printf 'PASS  %-42s -> %s\n' "codex dialog really did read busy before" "old bare substring matches it"; tally 0
else
  printf 'FAIL  %-42s -> %s\n' "codex dialog really did read busy before" "old rule would not have matched; fixture proves nothing"; tally 1
fi

# THE CONTAINMENT PROPERTY, as a test. The anchored rule is strictly NARROWER
# than the bare substring it replaced: every string it matches, the old rule
# matched too. WHAT THIS PINS IS THE DIRECTION OF THE CHANGE, not the
# correctness of every classification it removes. The subset property bounds the
# change to BUSY -> IDLE transitions and prevents new false-busy
# classifications; it cannot tell us whether a match the anchor drops was a
# false busy or a true one. The live Gemini footer-only control above
# (AGY_BUSY_ALT_PHASE) plus the separate counter and "Generating" markers are
# the evidence that known true-busy shapes remain covered. A future edit that
# widens the anchor to catch something the old rule missed gives the direction
# bound up, and fails here.
_containment_broken=0
for _f in "$AGY_BUSY" "$AGY_BUSY_ALT_PHASE" "$AGY_BUSY_INLINE_HINT" \
          "$CODEX_APPROVAL_DIALOG" "$PROSE_QUOTING_CANCEL" "$AGY_IDLE" "$AGY_STAGED"; do
  if printf '%s' "$_f" | grep -qE '(^[[:space:]]*|[(])esc to cancel' 2>/dev/null \
     && ! printf '%s' "$_f" | grep -qF 'esc to cancel' 2>/dev/null; then
    _containment_broken=1
  fi
done
if [ "$_containment_broken" = "0" ]; then
  printf 'PASS  %-42s -> %s\n' "anchored rule is strictly narrower" "no fixture matches anchored but not bare"; tally 0
else
  printf 'FAIL  %-42s -> %s\n' "anchored rule is strictly narrower" "a fixture matches the anchored rule the bare one missed"; tally 1
fi

# END-TO-END, and deliberately NOT under PUSH_DRY_RUN, so a wrong verdict shows
# up as an attempted delivery rather than a classifier opinion. The push must
# refuse to type into a live confirmation dialog: pressing Enter there ANSWERS
# it, on a human's behalf, with whatever option happens to be selected.
#
# Honest about what this proves. When the narrowing landed, the verdict here was
# skip:staged both before and after it, because inbox-push delivers-and-queues
# into busy panes rather than skipping them -- check_idle's verdict was never
# what stopped this one. The composer gate stopped it, by accident: the dialog's
# selected option carries Codex's own composer glyph, so find_composer_line read
# it and called the pane staged. That accident knows nothing about dialogs and
# would evaporate the moment Codex rendered its selection differently, which is
# why the refusal is now a named gate of its own (skip:dialog-pending). So this
# case remains the safety net for the narrowing rather than its red-green
# evidence -- that lives in the direct check_idle cases above -- and it now also
# pins that the refusal survived being made deliberate.
( export PANE_OVERRIDE="$CODEX_APPROVAL_DIALOG" RUNTIME_OVERRIDE="codex"
  run_case "codex approval dialog -> never delivered" "skip:dialog-pending" 2 ); tally $?

echo "inbox-push: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
