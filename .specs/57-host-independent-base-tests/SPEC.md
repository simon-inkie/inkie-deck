# #57: packages/base tests that fail on some hosts

- Issue: #57
- Branch: 57-host-independent-base-tests
- Started: 2026-10-11

## TL;DR

Under `env -i HOME=$HOME PATH=$PATH LC_ALL=C` with no `xxd`, 4 of 46 vitest
cases failed. Four host dependencies caused them: `xxd` in the inbox suite,
`$'\uXXXX'` fixtures in the inbox-push suite (bash emits `?` outside a UTF-8
locale), a multibyte bracket class in `bin/pane-idle`, and a create-agent test
that put node's install directory on PATH (which can hold a global `claude`).
All four are removed; the same command now passes 46 of 46.

## Scope

- `packages/base/test/inbox.test.sh`: `xxd -p` becomes `od -An -v -tx1`.
- `packages/base/test/inbox-push.test.sh`: `\uXXXX` escapes become UTF-8 byte
  escapes.
- `packages/base/bin/pane-idle`: spinner glyph class becomes an alternation, so
  it matches under any locale. This is a runtime fix, not only a test fix.
- `packages/base/test/create-agent.test.ts`: PATH exposes node via a
  node-only symlink directory.
- `packages/base/README.md`: drop the `xxd` requirement.

Out of scope: `rig/` still installs and checks `xxd`; harmless, see Follow-ups.

## Acceptance

- `cd packages/base && env -i HOME=$HOME PATH=$PATH LC_ALL=C npx vitest run`
  passes (PATH keeps pnpm/node; the stripped part is locale and tools), with no
  `xxd` and a `claude` beside node.

## Test plan

Before and after counts under the stripped environment, recorded in the PR.

## Decisions log

- 2026-10-11: `od` over `xxd`, since POSIX guarantees it. No skip needed.
- 2026-10-11: Byte escapes in fixtures rather than pinning a locale, so the
  suites need no UTF-8 locale installed.
- 2026-10-11: Fixed `pane-idle` in the script, because a cron or supervisor run
  under `LC_ALL=C` would have missed the spinner and typed into a busy pane.

## Follow-ups

- `rig/` stages list `xxd` as a required tool; can be dropped.
- `bin/pane-idle` uses `grep -P`, which BSD/macOS grep lacks.
- The create-agent no-runtime case assumes no system-wide `claude` in
  /usr/bin or /bin.

## Review feedback

Opus review, round 1 (approve with minor changes):
- Should-fix: `pane-idle` ctx bar regex used `[^│]`, a multibyte negated class
  that is byte-wise under C. Fixed with `grep -P` and a `(?!│).` lookahead.
- Should-fix: README overclaimed, and `BEFORE_BYTES`/`AFTER_BYTES` were never
  compared. Case 11 now asserts the after-bytes equal the before-bytes with only
  sent->read flipped; README reworded.
- Nits: PATH comment in create-agent test, `grep -P` and system-claude
  assumptions logged under Follow-ups, Acceptance command corrected.
