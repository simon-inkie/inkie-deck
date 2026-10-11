# 31 Warn when the resolved claude is a Windows binary under /mnt/

## TL;DR
On WSL, `claude` can resolve to a Windows executable. Add one shared check that warns, naming the path and the fix.

## Scope
- `packages/base/bin/claude-binary-check.sh`: `claude_binary_is_foreign`, `warn_if_foreign_claude`.
- Called from `boot-agents.sh`, `workspace.sh` (before launching claude) and `create-agent.sh` (before the verify probe).
- INSTALL.md note under Known limitations.

## Acceptance
- A path under `/mnt/` or ending `.exe`/`.cmd` prints a warning with the path, the problem and the fix.
- A normal path prints nothing.
- Launch is not blocked.

## Test plan
`packages/base/test/claude-binary-check.test.sh`, registered in `shell-suites.test.ts`: fake `/mnt/c` path, `.exe`/`.cmd`, normal paths, absent claude.

## Decisions log
- Warn only, not stop: a Windows claude can still run through WSL interop, and the path alone does not prove breakage. Stopping would lock out working setups.
- Case-insensitive on `.exe`/`.cmd` is limited to upper and lower forms; mixed case is not worth a `shopt`.

## Follow-ups
None.

## Review feedback
None yet.
