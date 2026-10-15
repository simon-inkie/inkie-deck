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
unbuilt one, `--no-memory`, or a failing install command, the final line reports
`create-agent: memory off (reason)`, a warning says why, and creation carries on with the
same exit code as before. INSTALL.md tier 3 gains an optional memory step. This
is the M1 slice only.

Known limitation, live: if the memory install command fails after the hooks
merged, Deck restores the agent's previous settings and reports it. The silo
may still be partly seeded (the command is idempotent, so re-running repairs
it). If the settings cannot be restored the report starts `off (PARTIAL: ...)`
and names the file to clean.

Also live: the first two commits on this branch carry a `Claude-Session:`
trailer that the repo's private-session-link rule flags. History was not
rewritten (no force-push), so a squash merge must drop those lines.

## Scope

In scope:
- `create-agent.sh`: `--memory-root`, `--no-memory`, `MEMORY_LAYER_ROOT`,
  `USER_NAME`, a `memory` line in the summary (off with its reason when
  nothing is to be wired, otherwise "to be wired after verification") and a
  final line with the outcome.
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
  generically. Relaxing
  the gate is a follow-up.

## Test plan

- `pnpm -C packages/base exec vitest run test/create-agent.test.ts`: 11 new
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

### 2026-10-14: review fixes
- What changed: (1) the "built" check now looks for the three
  `dist/claude-code/bin/*.sh` hook scripts and `node_modules/.bin/tsx` before
  the installer runs, because the real installer merges hooks first and exits 2
  afterwards when tsx is missing; a missing one reports
  `off (not built: missing ...)` and leaves settings untouched. (2) The test
  fixture uses a neutral silo directory name. (3) Memory is now wired on exit,
  after the verification probe, via an EXIT trap; the result is the last line of
  output. Choice: the probe runs the agent's real `claude -p` from its home, so
  wiring first would fire the memory hooks and could record the probe turn as
  the agent's first memory; keeping the probe out of memory was preferred over
  trying to disable hooks for one call. (4) Fixture installer is stricter
  (PreCompact auto and manual, tsx and built-script checks, hooks before the
  tsx check, as the real one); new tests for tsx missing, matchers and probe
  ordering.
- Why: review findings.
- Supersedes: the earlier "memory line in the summary" placement, and the
  directory-only built check.
- Commits: see branch

Note for the maintainer: the leak gate's private-session-link rule flags the
Claude-Session commit trailer, and the first two commits on this branch carry
it. A squash merge should strip any Claude-Session lines from the message.
Later commits omit it.

### 2026-10-14: merge of main, signals, doc fence
- What changed: merged main (the `--model` work) keeping both variable blocks and both summary lines. A SIGINT, SIGTERM or SIGHUP during the probe now clears the pending flag, so an interrupted run does not wire memory or claim it did (exit 130, 143 or 129). The summary memory line is conditional: `off (reason)` when nothing is to be wired, `to be wired after verification` otherwise. The INSTALL.md memory block is fenced `sh-manual`, because it needs a real checkout and the rig cannot run it.
- Why: re-review findings.
- Supersedes: the unconditional summary wording in the previous entry.
- Commits: see branch

### 2026-10-15: review round 3
- What changed: (1) memory is refused, settings untouched, when the agent's settings already carry a different `env.AGENT_NAME` (it would seed one silo and route hooks to another). (2) A snapshot of the settings is taken before the install command; on failure after the hooks merged they are restored, or a `PARTIAL` report names the file. (3) A symlinked `.claude` or `settings.json` is rejected before any write (a scaffold error at creation, and a second guard before wiring). (4) A failed probe (wrong phrase, empty reply, runtime error) now leaves memory unwired with a visible reason; skipped or impossible verification (`--no-verify`, no runtime) still wires. (5) A signal during the install prints `memory off (interrupted during memory install ...)` and restores the settings; a signal before wiring prints `off (run interrupted before memory was wired)`.
- Why: review findings (conflicting identity, partial state, symlink escape, interrupt report, wiring after a failed probe). New tests: failure after merge, unrestorable partial, conflicting identity, symlink, probe failure, probe error, interrupt during install.
- Supersedes: "reported off although hooks may be wired" in the TL;DR notes; the earlier rule that a failed probe still wired memory.
- Not done: removing `Claude-Session` trailers from the first two commits. That needs a history rewrite and force-push, which were ruled out; left for a decision (squash merge drops them).
- Commits: see branch
