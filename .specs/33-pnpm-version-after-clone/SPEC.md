# #33: pnpm --version check runs before the clone and fetches the wrong pnpm

- Issue: #33
- Branch: 33-pnpm-version-after-clone
- Started: 2026-10-07

## TL;DR

INSTALL.md ran `pnpm --version` in the prerequisites, before any clone. With no
`packageManager` field in reach, corepack fetched the latest pnpm instead of the
pinned one, after a `Y/n` download prompt the document never mentioned. The
check moves to section 2, inside the clone, the prompt is documented, and the
documented steps set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.

## Scope

In scope:
- INSTALL.md: `pnpm --version` and its recorded output move after the clone
  sentence in section 2; `node --version` stays in section 1.
- INSTALL.md: set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` after `corepack enable`
  and explain the prompt.
- `rig/install-plan.mjs`: the block ids change because section 2 gains a block.

Out of scope (and where it goes instead):
- Adding a clone step to INSTALL.md. Tracked by its own issue; this change only
  places the check after the sentence that already assumes a clone.

## Acceptance

- INSTALL.md's `pnpm --version` output matches the pinned version (10.34.5)
  on a clean machine, because it runs inside the clone.
- The corepack download prompt is mentioned and avoidable.

## Test plan

- `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm check:boundaries`,
  `pnpm check:leaks`, `pnpm check:licence`, `pnpm check:lib-version`,
  `pnpm -C packages/deck check:dashes`, on a clean tree.
- The rig (Docker) executes the INSTALL.md blocks. Not runnable in this
  session, so the block-id update in the plan is checked by reading.

## Decisions log

- Move the check rather than delete it: the pinned output is useful evidence
  that corepack honoured `packageManager`.
- Keep `node --version` in section 1: Node is not pinned by the repo, so
  checking it before the clone is correct.
- Set the prompt variable in the shell block, not only in prose, so scripted
  and rig runs never hang. It is per shell, which the text says.
- New block in section 2 is `sh#1`, so `pnpm install` becomes `sh#2`; the plan's
  DEPENDENCIES list is updated to claim both, or the rig fails on an
  unclaimed block.

## Follow-ups

- The section 1 apt line list and `corepack enable` run before any clone too,
  which is fine, but INSTALL.md still never says how to clone (separate issue).

## Check results

- Passing: install, typecheck, deck tests (2168), boundaries, leaks, licence,
  lib-version, dashes.
- Already failing on `main`, unchanged by this work: 4 tests in
  `packages/base` (`create-agent` CANNOT VERIFY case, and the `inbox` and
  `inbox-push` and `pane-idle` shell suites). Environment-related, not touched.
