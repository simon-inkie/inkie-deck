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

- `pnpm -C packages/base test` passes with `LC_ALL=C`, no `xxd`, and a PATH that
  has a `claude` beside node.

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

## Review feedback

None yet.
