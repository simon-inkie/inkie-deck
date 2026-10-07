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

## Follow-ups

- Readiness reporting for codex and other runtimes.
- Whether "runtime not running" should also give a non-zero exit; it would
  change the documented tier 3 exit code and the rig's expectation.
