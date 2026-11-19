# #21: Install the Brain from Deck setup (Slice 1)

- Issue: https://github.com/simon-inkie/inkie-deck/issues/21
- Branch: brain-install-slice-1
- Started: 2026-11-19

## TL;DR

`scripts/setup.sh --memory` installs and builds a pinned revision of the Brain
and wires each starter's own memory silo after its persona check. Memory is
opt-in and a Brain prerequisite or build failure does not change Deck's exit
status. The manual install offers the same per-agent observation loop.

## Scope

In scope:
- An optional checkout outside Deck, Node 22 or newer, frozen dependency
  install, build log and one setup-level explanation when memory is off.
- Per-agent wiring using the existing containment and rollback checks, with
  `USER_NAME` from `MC_USER`. Never edit user-level Claude settings.
- Probe before wiring; re-checks must not fire previously installed hooks.
- Quick setup and manual instructions, including what compaction records and
  how model calls are billed.

Out of scope:
- Semantic search, the MCP server and embeddings (M2); watcher and snapshots
  (M3); non-Claude runtimes; making memory the default.

## Test plan

- Run the setup, first-run and create-agent Vitest suites. Stub the Brain
  clone, builds, model CLI and tmux; use temporary homes. Check the pinned
  command sequence, per-agent hooks and routing, failure fallback, a rerun,
  probe ordering and byte-identical global settings.
- Check INSTALL.md block coverage with `node rig/self-test.mjs`; the optional
  Brain steps are manual, not part of the container install runs. Run the
  `install-doc` shape stage without starting the containers.
- Manual acceptance (not part of the offline tests): on a fresh Ubuntu WSL
  user, run `scripts/setup.sh --memory`, answer the CLI's prompts, send a real
  message and run `/compact` in the assistant's pane. Check for a new file in
  `~/.the-brain/agents/<assistant>/memory/observations/` and `observe-trigger`
  with `fired: true` in `~/.the-brain/logs/hook-activity.jsonl`. Check that no
  observation landed in a different silo.

## Follow-ups

- Replace the commit pin with a Brain release tag once available (#21).
- Add per-agent recall instructions that do not assume semantic search is
  configured; the upstream template advertises the M2 tool and index (#21).
- Run and record the WSL acceptance check, including build time and size,
  before considering default-on or adding a live Brain rig stage (#21).

## Log

### 2026-11-19: Start Slice 1

- Reuse the post-probe wiring path from the first memory milestone. Quick
  setup first scaffolds without memory, then requests wiring on successful
  verification. Existing project hooks stay disabled during re-checks.
- The shape stage found an existing unclaimed Nudges opt-out example. Declare
  it skipped because it changes a running rig's configuration and needs a
  restart; the Brain block remains manual.
- Validated offline with the targeted Vitest and shell suites, typecheck,
  leak and licence gates, the dash scan and the INSTALL.md shape stage.
  Live Brain build and compaction acceptance remain unverified.
- Commits: 2a5d4fb feat(setup): opt-in Brain install, wired after the persona check (#21)

### 2026-11-19: Protect memory setup on reruns

- What changed: Require jq before preparing memory. Reuse a verified build at
  the pinned revision and leave an existing build untouched if it cannot be
  verified. Cover both cases in the offline setup tests.
- Why: Without jq, live recall silently stops updating. The pinned build
  removes dist before compiling, so a failed or interrupted rebuild can break
  hooks that agents already use.
- Commits: pending
