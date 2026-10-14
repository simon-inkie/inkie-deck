# #21: Memory loop install path for tier-3 agents (M1 slice)

- Issue: #21
- Branch: claude/dazzling-davinci-h66qwp-issue-21
- Started: 2026-10-14

## TL;DR

`packages/base/bin/create-agent.sh` can now wire the memory loop for a new
agent. Given a built memory-layer checkout (`MEMORY_LAYER_ROOT` or
`--memory-root`), it runs the checkout's own non-interactive install command
against that agent's own `.claude/settings.json` (hooks) and seeds the agent's
silo, then records `USER_NAME` in the settings env. With no checkout, an
unbuilt one, `--no-memory`, or a failing install command, the summary reports
`memory  off (reason)`, a warning says why, and creation carries on with the
same exit code as before. INSTALL.md tier 3 gains an optional memory step. This
is the M1 slice only.

Known limitation, live: if the memory install command fails part way (for
example after the hooks merge but before the silo is seeded) the agent is
reported `off` although its settings may already hold the hooks. The warning
says so; the command is idempotent, so re-running it repairs it.

## Scope

In scope:
- `create-agent.sh`: `--memory-root`, `--no-memory`, `MEMORY_LAYER_ROOT`,
  `USER_NAME`, a `memory` line in the summary.
- Tests for present, absent, unbuilt, failing, `--no-memory` and unset
  `USER_NAME`, all in temporary directories.
- INSTALL.md optional memory step.

Out of scope (follow-ups, below): semantic search, paid-key setup, watcher and
systemd, leak-gate relaxation and linking the project from docs, the
`TOOLS.md` and recall-instruction work, the `CORE.md` persona question, path
convention docs, and any cross-repository rollout.

## Verified memory-layer interface (v0.3.0, after its #11 landed)

- `scripts/install.sh [--settings FILE] [--agent NAME [--link DIR]]
  [--skip-build] [--dry-run]`. Non-interactive and idempotent, any checkout
  name. Exit 0 ok, 1 bad args, 2 prerequisite/build, 3 unusable settings.json;
  an `agent init` failure is passed through.
- It requires a prior `pnpm build` (`dist/claude-code/bin/*.sh`) and, for
  `--agent`, `node_modules/.bin/tsx`. Deck does not build the checkout.
- Hooks merged: `UserPromptSubmit`, `Stop`, `PreCompact` (auto and manual),
  other settings and hooks kept, one backup kept beside the file.
- `agent init <name>` writes the silo under `$HOME/<silo dir>/agents/<name>`;
  routing tier 0 is the `AGENT_NAME` env var, which Deck already writes, so
  `--link` is not used and no pointer file lands in the agent home.
- `AGENT_NAME` and `USER_NAME` are read from the per-worktree settings env.

Incompatibilities with the issue text and with assumptions in it:
- The issue says "the brain repo's install command", but the interface is
  `scripts/install.sh` with a prior build. Deck therefore needs a built
  checkout and reports `off (not built)` rather than building one.
- Deck's default `INBOX_ROOT` (`~/.the-vault/agents`) and the layer's silo
  root differ; harmless here because silo routing is by `AGENT_NAME`.
- The persona-inject hook reads `~/agents/<name>/CORE.md`, which Deck
  templates do not ship, and that hook is not part of the three installed
  hooks. Left alone.
- The leak gate rejects the memory layer's name, so this change refers to it
  generically (and the test file splits the silo directory name). Relaxing
  the gate is a follow-up.

## Test plan

- `pnpm -C packages/base exec vitest run test/create-agent.test.ts`: 8 new
  memory cases using a fixture checkout that honours the interface above.
- Manual: the real `scripts/install.sh` hook merge run against a copy of the
  checkout in a temporary HOME. `agent init` through the real `tsx` was not
  run (dependencies could not be fetched in the sandbox).
- Full check list from CONTRIBUTING.md.

## Follow-ups

- M2: semantic search guidance and the recall MCP server in agent settings.
- M3: watcher daemon and systemd units, tied to Deck startup.
- Leak-gate relaxation for the public memory-layer name, with a self-test.
- `TOOLS.md` naming the memory layer; installing its recall instruction into
  each agent home.
- Path convention docs; decide on shipping `CORE.md` for persona-inject.
- A tier-3 rig stage for the memory step, and an end-to-end check against the
  real built checkout (observation written after `/compact`).

## Log

### 2026-10-14: M1 install path
- What changed: added the wiring, tests, INSTALL.md step and this SPEC.
- Why: issue #21 M1, restricted to the opt-in-safe path.
- Supersedes: nothing, additive
- Commits: see branch
