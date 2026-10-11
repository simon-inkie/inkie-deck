# 31 Warn when the resolved claude is a Windows binary under /mnt/

## TL;DR
On WSL, `claude` can resolve to a Windows executable. Add one shared check that warns, naming the path and the fix.

## Scope
- `packages/base/bin/claude-binary-check.sh`: `claude_binary_is_foreign`, `warn_if_foreign_claude`.
- Called once per run from `boot-agents.sh` and `workspace.sh` (before the launch loop) and `create-agent.sh` (before the verify probe).
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
Opus round 1 (approve, no blockers):
1. Warning printed once per agent. Fixed: called once before the loop in boot-agents.sh and workspace.sh.
2. INSTALL.md note sat above the section's opening line. Fixed: moved alongside the other bold entries.
3. Check runs in the script's shell, not the tmux pane's. Documented as best-effort in the lib header.
Nits, not changed: symlinks are not resolved (noted in the lib header); any Linux path under /mnt/ warns (accepted); mixed-case .Exe missed (deliberate).
