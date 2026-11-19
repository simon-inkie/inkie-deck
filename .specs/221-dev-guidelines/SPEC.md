# #221: Contributor guidance for testing and UI components

- Issue: https://github.com/simon-inkie/inkie-deck/issues/221
- Branch: `dev-guidelines`
- Started: 2026-11-19

## TL;DR

Add short contributor guides for tests, Nudges, and UI components, and link
them from the development workflow. Document what exists separately from a
proposed opt-in pattern for agent evals.

## Scope

In scope:
- Testing guidance for Vitest, shell scripts, the install rig, and Nudges.
- A proposed eval pattern, plus guidance on UI primitives, styling, and review.

Out of scope:
- Changes to application code, test suites, scripts, or tooling.
- Running the full suite, the rig, or live agents.

## Test plan

- Check paths and command examples against the repository.
- Run `node scripts/leak-gate.mjs`, `pnpm check:leaks`, `pnpm check:licence`,
  `node packages/deck/scripts/check-dashes.mjs`, and `git diff --check`.
- Check the new Markdown for ASCII and whitespace.

## Follow-ups

- No follow-up issues filed; unresolved conventions go in the guides.

## Log

### 2026-11-19: Start documentation from the existing tree
- What changed: Set the scope and checks on the existing `dev-guidelines` branch.
- Why: The guides need to distinguish current practice from proposed tooling.
- Supersedes: nothing, additive
- Commits: pending

### 2026-11-19: Document both guides and check them offline
- What changed: Added the guides and workflow links. The licence gate,
  direct ripgrep dash scan, ASCII scan and diff whitespace check passed.
- Why: Both leak invocations hit a `spawnSync git EPERM` error, and the Node
  dash wrapper timed out, so the direct dash scan used ripgrep. No full
  suite or live agents ran for these documentation-only changes.
- Supersedes: nothing, additive
- Commits: pending
