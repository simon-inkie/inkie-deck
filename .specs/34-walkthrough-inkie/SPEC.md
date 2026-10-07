# #34: Rename the walkthrough's first agent from wren to inkie

- Issue: #34
- Branch: 34-walkthrough-inkie-5dvzjd
- Started: 2026-10-07

## TL;DR

The walkthrough's first example agent is now `inkie` instead of `wren`, in the
docs, the usage examples in two scripts, and the install-verification rig's
agent-install stage (which asserts the tmux window name and the reply sender).
`INSTALL.md` gains a line saying any lowercase name works.

## Scope

In scope:
- `INSTALL.md`, `packages/base/README.md`.
- Usage comments in `packages/base/bin/boot-agents.sh` and
  `packages/base/bin/workspace.sh`.
- `rig/stages/08-install-agents.mjs`, in the same commit as the docs, because
  the rig runs the documented commands and asserts the window name.
- One line in `INSTALL.md` noting that any lowercase name works.

Out of scope:
- Test fixtures (`packages/base/test/*`), which keep `wren` on purpose.
- `packages/base/ROSTER.md` (see Follow-ups).

## Acceptance

- A case-sensitive search for `wren` outside `packages/base/test/` finds
  nothing.
- The install-verification rig stays green.
- `pnpm typecheck`, `pnpm test` and the check scripts pass.

## Test plan

- `rg wren` shows hits only under `packages/base/test/`, plus the ROSTER entry
  noted below.
- Run the repo's checks: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
  `pnpm test`, `pnpm check:boundaries`, `pnpm check:leaks`,
  `pnpm check:licence`, `pnpm check:lib-version`,
  `pnpm -C packages/deck check:dashes`.
- Run the rig self-test if it can run here.

## Decisions log

- Replaced the whole word `wren` with `inkie` mechanically, so the doc, the
  scripts and the rig cannot disagree. The `boot-agents.sh` comment about
  resuming sessions now reads "inkie" and "inkie-scratch".
- Worded the note as "`inkie` is only an example: any lowercase name works",
  matching the name rule in `create-agent.sh` (lowercase letters, digits,
  hyphens).
- Left `ROSTER.md` alone. Its `**Wren**` entry is a separate fictional
  teammate in a worked roster example, not the walkthrough agent, and the
  issue does not list that file.

## Follow-ups

- `packages/base/ROSTER.md` still has a fictional "Wren" persona. Rename it if
  the acceptance search is meant to be case-insensitive.
