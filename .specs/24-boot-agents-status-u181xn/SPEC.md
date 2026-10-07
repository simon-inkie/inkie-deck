# #24: boot-agents.sh reports "launched + armed" while the pane is waiting on a Claude Code prompt

- Issue: #24
- Branch: 24-boot-agents-status-u181xn
- Started: 2026-10-07

## TL;DR

`boot-agents.sh` said "N launched + armed" as soon as it had typed a launch
command, so a fresh agent stopped at Claude Code's folder trust screen (or any
other first-run screen) was reported as working. After launching, the script
now samples each Claude agent's pane and reports it as ready, waiting on a
Claude Code prompt, or not running. The folder trust screen is recognised by
name, with the exact choice to make. Any agent waiting on a prompt makes the
script exit 3, and auto-arm no longer types into a pane that is not ready.

## Scope

In scope:
- A readiness check in `packages/base/bin/boot-agents.sh` for agents on the
  `claude` runtime, reusing `check_idle` from `bin/pane-idle`.
- Recognising the folder trust screen and naming the choice to make.
- A per-agent summary and a distinct exit status (3) for "launched but
  waiting on a prompt".
- Skipping auto-arm for an agent that is not ready.
- A "First boot" paragraph in INSTALL.md tier 3, including the permission
  mode agents run in.
- Fixture tests in `packages/base/test/boot-agents.test.sh`.

Out of scope (and where it goes instead):
- Writing Claude Code's internal trust config to pre-accept the folder. The
  issue rules this out without a decision; it is version-fragile.
- Readiness checks for codex and other runtimes. Codex already has its own
  launch verification. See Follow-ups.
- The resume picker shown by `claude --resume` (the linked issue).

## Acceptance

- With a fresh agent, `boot-agents.sh` exits with a summary naming each agent
  stuck at a prompt, and exit status 3 for "launched but waiting".
- INSTALL.md tier 3 has a "first boot" paragraph.
- A test covers a pane fixture showing the trust screen.

## Test plan

- `bash packages/base/test/boot-agents.test.sh` (also run by `pnpm test`
  through `shell-suites.test.ts`): the pure classifier against fixtures for
  the trust screen (numbered and unnumbered, with either option selected), an
  unknown first-run prompt, a ready composer, a busy pane, a composer above a
  background-task list, and the trust literal quoted in transcript prose above
  a ready composer.
- The polling wrapper against a stubbed pane: early exit on ready and on the
  trust screen, "not running" when the pane holds a shell, "prompt" at the
  deadline.
- The repository's check list from CONTRIBUTING.md.
- Not covered: a live Claude Code pane. The rig has no model CLI, so it only
  sees the "not running" path, which keeps exit 0.

## Decisions log

### 2026-10-07: picked up, approach chosen
- What changed: SPEC created. Plan: a pure classifier `boot_pane_state` over
  captured pane text, a polling wrapper over a shared deadline, a summary,
  exit 3, and auto-arm gated on readiness.
- Why:
  - Prompts change between Claude Code versions, so "waiting on a prompt" is
    the absence of a ready composer, not a list of known prompts. Only the
    trust screen is named, because it needs a specific answer.
  - Ready means a prompt glyph line directly under a box-drawing rule, the
    anchor `find_composer_line` in `bin/pane-idle` uses. That function itself
    is not reused: when no rule-anchored line exists it falls back to the last
    prompt-glyph line, and a selection menu's highlighted option ("> No,
    exit") would then read as a ready composer.
  - `check_idle` is reused: a busy pane (mid-turn) counts as ready.
  - Auto-arm types text and then Enter. On the trust screen with "No, exit"
    preselected, that Enter exits Claude Code, so arming only ready panes is
    part of this fix rather than a separate change.
  - Exit 3 only for "waiting on a prompt". A pane where the runtime is not
    running is reported but keeps exit 0: INSTALL.md tier 3 runs the script
    on a machine with no model CLI and documents exit 0 there, and the rig
    asserts it. See Follow-ups.
  - Already-running Claude agents are sampled once too, so re-running the
    script after a stalled first boot does not report "already up" as if it
    were fine.
- Supersedes: nothing, additive
- Commits: docs(base): spec for boot readiness reporting (#24)

### 2026-10-07: readiness check, report, exit 3, tests and docs
- What changed: `boot_pane_state`, `boot_wait_for_ready` and
  `boot_readiness_message` above the library boundary of `boot-agents.sh`;
  the boot sequence polls fresh claude panes against one shared deadline
  (`BOOT_READY_TIMEOUT_SECS`, default 30), samples already-up claude panes
  once, prints per-agent lines and a summary, gates auto-arm on readiness and
  exits 3 when any agent is waiting. INSTALL.md tier 3 gains "First boot".
  16 "R" cases in `boot-agents.test.sh`, two of them end to end against a
  stub tmux on PATH.
- Why: as planned above. Two details settled while writing it:
  - No associative array for the fresh/up split: bash 3.2 (macOS) has none,
    and the script already guards for it.
  - The trust message does not claim "No, exit" is always preselected. The
    issue saw it preselected; the numbered render preselects Yes. The message
    says not to press Enter until the right option is selected, which is
    true for both.
- Checks: typecheck, check:boundaries, check:leaks, check:licence,
  check:lib-version and check:dashes pass. `pnpm test` has 4 failures
  (create-agent "CANNOT VERIFY", inbox.test.sh, inbox-push.test.sh,
  pane-idle.test.sh) that fail identically on `main` in the same container,
  which has `claude` on PATH and no UTF-8 locale. `check:leaks:messages`
  flags three commits already on `main`; this branch's commits are clean.
- Supersedes: nothing, additive
- Commits: fix(base): report boot readiness instead of claiming launched + armed (#24)

### 2026-10-07: review feedback recorded
- What changed: the review of PR #54 is recorded under "Review feedback"
  below. No code changed in this commit.
- Why: the maintainer asked for the feedback to live in the SPEC folder.
- Supersedes: nothing, additive
- Commits: docs(base): record PR 54 review feedback in spec (#24)

### 2026-10-07: patch for the review findings
- What changed:
  - The main loop now matches `launched`, `skipped` and `skipped:<reason>`
    explicitly. A refused launch (provider switch in progress, unreadable
    provider state) is printed as "not launched: <agent> (<reason>)" and is
    in neither the launched nor the already-up count. The already-up count is
    now the real number of skipped-because-running agents, not
    `agents - launched`.
  - Readiness polling is now `boot_poll_ready`: one reading per unsettled
    agent per round, rounds repeating to the shared deadline, replacing
    `boot_wait_for_ready` (agent after agent). One agent stuck at an unknown
    prompt can no longer leave later agents with a single reading and a false
    exit 3. A test pins exactly that case.
  - INSTALL.md "First boot": sample output uses `inkie`; documents
    `BOOT_READY_TIMEOUT_SECS` (what it counts from, what a timeout looks like,
    how to raise it) and the not-launched line; the permission-mode sentence
    no longer states a default, since this PR does not verify one; the resume
    picker is no longer listed as a first-run screen, here and in the script's
    comments (#55 makes launches pin a session, so it should not appear).
  - Tests: the wait cases are rewritten for the round-robin poller, plus a
    starvation case and an end-to-end provider-switch case. 60 pass.
- Why:
  - Finding 2: `skipped:provider-switch` was matched by nothing, so the agent
    was never checked and was counted as already up.
  - Finding 3: the false exit 3 was real. The deadline was shared but spent in
    order. Rounds fix the cause; a longer default would only have hidden it.
    The readiness check still starts only after the last launch and its
    stagger, which keeps the fix small. Panes launched early have had longest
    to settle, so this errs towards fewer false waits.
  - Finding 4: the PR cannot verify Claude Code's default mode, so it states
    none.
  - Finding 5: reworded now rather than after #55, because the wording is
    false the moment #55 merges and still harmless before.
  - Finding 6: the new tests are inserted inside the readiness block, which
    sits at the end of the file, so a merge with #55 conflicts only where both
    append after the same line. Resolve by keeping both blocks. Rebasing onto
    #52 and #55 is not done here: neither is merged, and rebasing onto an
    open PR's branch would couple this PR's history to theirs. After they
    merge, update this branch from `main`.
  - `wren` in INSTALL.md outside the First boot block is #52's rename to make,
    not this PR's.
- Supersedes: the `boot_wait_for_ready` description in "readiness check,
  report, exit 3, tests and docs" above; that function no longer exists.
- Commits: fix(base): poll readiness in rounds and report refused launches (#24)

## Review feedback

Review of PR #54 (2026-10-07), one pass over the five open PRs #52 to #56.
Verdict: minor changes needed. Each finding carries its outcome (fixed,
declined or deferred), updated when a commit resolves it.

1. INSTALL.md sample output names `wren`. The "First boot" block shows
   "wren is waiting..." and "1 launched (wren)". Once #52 (rename the sample
   agent from `wren` to `inkie`) lands, this breaks #52's acceptance, so the
   sample should say `inkie`. Status: fixed (see the 2026-10-07 patch entry).
2. `skipped:provider-switch` falls through the main loop. `launch_agent`
   can echo `skipped:provider-switch` (and `skipped:provider-state`), which
   matches neither `launched` nor `skipped`. The agent lands in neither FRESH
   nor UP, is never readiness-checked, and still counts as "already up" in
   the `${#AGENTS[@]} - ${#FRESH[@]}` arithmetic. Match `skipped*` or handle
   it explicitly. Status: fixed (see the patch entry).
3. Readiness polling can give a false exit 3 on a slow multi-agent boot.
   Readiness is polled only after every launch and its 12s stagger, and
   fresh agents are checked one after another against a single 30s deadline.
   With several agents on a slow first boot, later ones get about one sample
   and can be reported as "prompt" while still loading. Consider documenting
   `BOOT_READY_TIMEOUT_SECS` in INSTALL.md. Status: fixed (see the patch entry).
4. Unverified permission-mode claim. INSTALL.md says the default permission
   mode is "auto, at the time of writing". That is a claim about Claude Code
   defaults the PR does not verify; soften or verify it. Status: fixed (see the patch entry).
5. "Resume picker" wording goes stale after #55. Once #55 merges, the resume
   picker is no longer a first-run screen, so the INSTALL.md text and the
   comments that list it should be reworded. Status: fixed (see the patch entry).
6. Merge order. #54 and #55 both append tests at the end of
   `packages/base/test/boot-agents.test.sh` (after line 805); keep both
   blocks when resolving. Rebase #54 onto #55 and #52. Suggested merge
   order: #53, #56, #52, #55, #54. Status: handled as far as this branch can; the rebase itself waits on #52 and #55 merging (see the patch entry).

Nits, no action needed:
- The `2>/dev/null` mid-pipeline in `boot_pane_has_trust_prompt` applies only
  to `sed`. Harmless.
- The trust check matches the literal UI text "Yes, I trust this folder".
  Accepted by design.

## Follow-ups

- Readiness reporting for codex and other runtimes.
- Whether "runtime not running" should also give a non-zero exit; it would
  change the documented tier 3 exit code and the rig's expectation.
