# #153: Replace tmux with a cross-platform node-pty runner

- Issue: https://github.com/simon-inkie/inkie-deck/issues/153
- Branch: `153-node-pty-runner`
- Started: 2026-11-18
- Scope of this SPEC: the first slice only. Later work is planned outside
  this file and gets its own issues when it is ready.
- Companion: #154 (Agent Client Protocol, `.specs/154-agent-client-protocol/`).
  Related: #155 (structured task flows).
- ISSUE-TEXT.md in this folder is an adapted copy of the published issue
  body: the original link to an internal tracker was removed for this
  repository. The rest is unchanged.

## TL;DR

Deck drives terminal agents through tmux: it types with `send-keys` and
reads back with `capture-pane`. This first slice adds a runner adapter
(launch, input, output, resize, cancellation, exit) and a node-pty
implementation of it, and proves that implementation in an isolated
fixture only. Production behaviour does not change: every real agent stays
on tmux, no route or script can select the new runner, and no new browser
input to a terminal is added. The slice also records an inventory of what
a later live change would touch, and the drained-cutover rule any such
change must follow.

## Motivation, briefly

Deck infers from the screen whether a message landed and whether an agent
is busy. Several recurring delivery problems in the base package's push
and idle scripts trace back to that inference: text and Enter racing, long
pastes collapsing into a placeholder the screen check cannot match, Enter
landing on a confirmation dialog, idle checks drifting between copies, and
text sent to a pane whose agent had exited reaching a shell (#25). tmux is
also not available natively on Windows (#26). This is the motivation, not
a complete causal audit of every incident.

A runner Deck owns in TypeScript is the first step: it can see the child
process exit, own its process group and talk to it directly. It does not by
itself remove screen inference; that needs a structured signal from the
agent, which is later work (and #154 for agents that speak ACP).

## Scope

In this slice:
- A `Runner` interface for launch, input, output, resize, cancellation and
  exit.
- `TmuxRunner`: a thin wrapper over today's tmux functions, used only by
  the contract tests in this slice. Production routes and scripts keep
  calling today's code unchanged.
- `PtyRunner`: a node-pty implementation, selectable only through a
  fixture registry in a temporary directory.
- A scripted fixture agent and a contract test suite run against both
  runners.
- node-pty as an optional, lazily loaded dependency.
- The touch-point inventory and the drained-cutover rule (below).

Not in this slice:
- Running any real agent on the PTY runner, or any per-agent switch for
  real agents.
- Any browser terminal input, WebSocket or new route for PTY sessions.
- Changes to `inbox-push`, the sweeps, the boot scripts or the Deck send
  route and terminal view.
- Delivery acknowledgement from agent hooks, event-derived busy and idle,
  restart survival, native Windows, and changing the default runner.

## Independence

This slice needs nothing from #154 or #155, and they need nothing from it.
The shared event envelope is defined in #154's SPEC; this slice does not
emit envelope events.

## The runner adapter

```ts
interface Runner {
  kind: "tmux" | "pty";
  caps: {
    terminalAttach: boolean;
    deliveryAck: boolean;   // false for both runners in this slice
    stateEvents: boolean;   // false for both runners in this slice
  };
  launch(spec: SessionSpec): Promise<SessionHandle>;   // rejects explicitly on failure
  write(text: string): Promise<WriteResult>;           // refused after exit
  key(name: PaneKey): Promise<WriteResult>;            // today's allowlist
  output(): AsyncIterable<Uint8Array>;
  resize(cols: number, rows: number): Promise<void>;
  cancel(): Promise<void>;                             // interrupt, e.g. Ctrl+C
  stop(mode: "graceful" | "kill"): Promise<ExitInfo>;
  exited(): Promise<ExitInfo>;
}
```

Requirements:
- `launch` reports a failed start (missing binary, immediate exit, spawn
  error) as a typed failure, never as a running session.
- `write` and `key` are refused with a typed result once the child has
  exited. This carries forward today's refusal to send into an ended
  agent's shell. For `TmuxRunner` the existing check is reused.
- `stop` and the end of the fixture leave no child processes behind. The
  PTY runner starts the child in its own process group (a job object on
  Windows, later) and kills the group. This is a requirement to prove in
  tests, not an assumed guarantee.
- `caps.deliveryAck` and `caps.stateEvents` are false. A write is reported
  as written, never as delivered or accepted.

## Fixture-only selection

- `PtyRunner` is constructed only by a fixture registry: a test helper
  that takes an explicit registry directory, which must be inside the
  operating system's temporary directory, and refuses any other path.
- No production module imports `PtyRunner`. A test asserts this by
  scanning the import graph of the Deck server entry, its routes and
  `server/*.mjs`.
- No environment variable, agent file or setting read by production code
  selects a runner. Real agents cannot be switched in this slice.
- The fixture's child environment is an explicit allowlist. Deck's own
  secrets are never passed to a fixture child.
- No network listener of any kind is opened by the PTY runner.

## The fixture agent

A small scripted program run inside the PTY that imitates the shapes that
matter: a composer prompt, bracketed-paste mode, a long paste collapsing to
a placeholder, a confirmation dialog, delayed output, a slow start, a
failed start, and exiting to a shell. It runs in CI.

One real CLI may also be run by hand in a scratch home with no access to
real agent state, as a recorded conformance note for that CLI version on
that platform. That note is evidence for that version and platform only.

## node-pty as an optional dependency

- Loaded lazily. If it is missing or fails to load, Deck installs and runs
  unchanged and the PTY runner reports "unavailable" with the reason.
- A failed native build must not fail `pnpm install` or the setup flow
  (#151). pnpm's allowlist for dependency build scripts names node-pty; the
  licence gate must pass for it.
- Unverified inputs, to check for the pinned version before relying on
  them: which OS, architecture and Node major combinations have prebuilt
  binaries; what a source build needs on each OS; the ConPTY behaviour and
  minimum Windows build. Documentation and synthetic fixtures do not prove
  acceptance on Linux, macOS or Windows; each needs its own evidence.

## Touch-point inventory

Paths beginning with `bin/` are in `packages/base`; `app/`, `scripts/` and
`deploy/` below are in `packages/deck`. Nothing in this table changes in
this slice.

| Touch point | Reads or writes today | Later action |
| --- | --- | --- |
| `bin/inbox-push` | Reads inbox and pane state; sends messages and Enter to an exact live pane. | Guard admission and replace tmux dispatch for migrated agents. Keep persisted messages. |
| `app/routes/threads.$agent.tsx`, `app/components/MessageBubble.tsx` | The route persists messages before wake/push, serves terminal snapshots and sends pane fingerprints to the chat view. The bubble uses changes as a working hint. | Guard dispatch and replace capture and the working hint for migrated agents, not persistence. |
| `app/routes/api.tmux-send.tsx`, `app/lib/instance.server.ts` | Guard browser text and named-key submission; read the instance feature flag and agent/window identity. | Guard by ownership and input permission; retire the legacy endpoint only after tmux callers are gone. |
| `app/lib/tmux.server.ts`, `app/lib/tmux-submit.ts` | List windows, capture rendered output, classify panes, wake/push and verify text and Enter against viewport samples. | Replace dispatch and capture; guard the tmux-only heuristics for legacy panes and retire them after cutover. |
| `bin/stuck-pane-sweep.sh`, `bin/pane-idle` | Read pane state and terminal prompts; report stuck agents or send an escalation to a routing pane. `pane-idle` provides the shared shell classification. | Guard against acting on migrated agents, replace the state source and escalation dispatch, then retire the scrape-specific rules. |
| `bin/activity-sweep.sh`, `app/lib/activity.server.ts`, `app/lib/activity.shared.ts` | Sweep panes and other signals into activity snapshots including busy/idle, context and recent work. Deck reads and interprets the snapshots. | Replace pane-derived fields at the producer; preserve the snapshot contract or migrate its readers together. |
| `bin/activity`, `app/components/ActivityPanel.tsx`, `app/routes/tmux.tsx`, `app/routes/shell.tsx` | Read the activity view for agent status, context and escalations. The Team route joins it against tmux window names. | Replace the tmux window join; preserve non-pane context and stale/offline semantics, including for CLI readers. |
| `app/lib/codex-quota-display.server.ts`, `app/lib/codex-quota-observer.server.ts`, `app/lib/codex-quota-store.server.ts`, `app/components/CodexQuotaStatus.tsx` | Read and store quota observations separately from terminal text; the layout surfaces the result. | Guard that runner changes preserve this independent source; do not replace it with terminal scraping. |
| `app/components/TmuxPane.tsx`, `app/routes/tmux.tsx`, `app/routes/threads.$agent.tsx` | Poll loaders for viewport snapshots, display the panes and post terminal input to the tmux route. | Replace presentation and polling only with an authorised terminal transport; guard old input. |
| `app/routes.ts`, `app/components/AppShell.tsx` | Register and link the Team and per-thread terminal surfaces. | Guard availability and retire tmux-specific links/routes once unused. |
| `bin/boot-agents.sh`, `bin/workspace.sh`, `bin/claude-session.sh`, `bin/claude-binary-check.sh` | Own tmux workspace/agent start and resume; validate the CLI expected to run in a pane. | Guard single ownership during draining; replace migrated launch and resume paths. |
| `bin/codex-provider-switch` | Reads pane identity, working directory and quiescence; interrupts, launches and checks the selected CLI in that pane. | Guard against operating on a migrated agent; replace only with equivalent ownership and rollback checks. |
| `bin/create-agent.sh`, `app/lib/agent-model.server.ts`, `app/routes/api.agent-model.tsx`, `app/components/ModelSelector.tsx` | Create agent configuration or persist the next-launch model; do not switch an active pane through the model selector. | Preserve provisioning and persist-only behaviour; guard backend-specific identity assumptions. |
| `app/lib/cron.server.ts`, `app/lib/cron-validate.ts`, `app/routes/scheduler.tsx`, `app/routes/api.cron.tsx` | Validate and store schedules; generated agent-mode jobs load a tmux buffer, paste and press Enter. Script-mode jobs are separate. | Replace agent-mode jobs and guard already-installed jobs during drain; leave script mode alone. |
| `scripts/dev.mjs`, `deploy/deck.service`, setup and operator docs | Configure or describe tmux prerequisites and runtime assumptions. | Guard legacy setup while tmux is supported; retire its prerequisite and update the docs when it is removed. |

## Drained cutover rule

No live agent changes runner in this slice. Any later change must follow
this order, and its own issue must show how:

1. Stop admission: new messages are still persisted, but not pushed.
2. Settle in-flight work: the current turn ends and every in-flight push
   has a final status.
3. Confirm ownership: exactly one runner owns the agent before the other
   starts, and two processes never run on one conversation.
4. Only then replace the old runner, with a tested way back.

## Testing

Covers the core behaviour and the dangerous risks (input reaching the wrong
place, orphaned processes), not every edge case. One contract suite, run
against `TmuxRunner` (in a private tmux server on a temporary socket, never
the user's) and `PtyRunner`:

- delayed output is delivered in order and complete;
- a failed launch is reported as a failure;
- `cancel` interrupts the fixture's current task;
- after `stop`, and after the fixture exits on its own, no child process
  remains (checked by process group);
- `write` and `key` after exit are refused, and nothing reaches a shell;
- `resize` is seen by the fixture.

Plus: the fixture registry refuses a non-temporary path; the import-graph
test; Deck runs with node-pty absent; the existing Deck and base test
suites pass unchanged.

## Acceptance

- The contract suite passes against both runners on Linux in CI; other
  platforms are reported separately with their own evidence.
- No production module can select or import the PTY runner; production
  tmux behaviour is unchanged.
- No new browser input, route or listener exists for PTY sessions.
- With node-pty absent, Deck installs and runs, and the PTY runner reports
  why it is unavailable.
- The touch-point inventory and the drained-cutover rule are in this SPEC.

## Decisions for the maintainer

Recommendations only.

1. Fixture-only first slice, with no live selection. Recommendation: yes.
   The alternative is to widen this slice with every guard a live PTY path
   needs, which makes it much larger.
2. `TmuxRunner` used only by tests in this slice, with production routes
   untouched. Recommendation: yes; wiring routes through it is later work.
3. node-pty optional and lazily loaded. Recommendation: yes.

## Log

### 2026-11-18: SPEC drafted
- What changed: wrote this SPEC and ISSUE-TEXT.md. A first draft covered
  the whole migration in one file; after a privacy and scope review the
  same day it was cut to the first slice only, with live selection,
  browser input and later phases moved out of this repository's plan.
- Why: maintainer direction to pick up the move off tmux; the review asked
  for first-slice public specs with the fixture fenced from live agents.
- Supersedes: nothing in this repository.
- Commits: none yet.

### 2026-11-18: Implementation picked up
- What changed: picked up the first slice on the implementation branch with
  the optional dependency and lockfile already prepared.
- Why: prove the contract before changing any live path. The installed package
  has no loadable Linux binding; try an offline build in scratch for validation.
- Supersedes: nothing, additive.
- Commits: pending maintainer commit.

### 2026-11-18: Fixture contract implemented
- What changed: added both adapters, the fixture program and registry, and
  shared contract and import-graph tests. Filled the live touch-point table;
  the drained-cutover rule is unchanged. Added tmux to Linux CI and node-pty
  to the workspace build-script allowlist. The installed node-pty manifest
  declares MIT; the licence gate checks the repository licence only and
  needs no configuration change.
- Decisions: accepted fixture-only selection, test-only `TmuxRunner`, and
  optional lazy loading. **Placement:** all new modules live under
  `packages/deck/test/runner`. **Launch:** single-use runner, fixed fixture
  executable and scenarios, explicit readiness marker with a deadline,
  typed `start-failed` or `unavailable`. **Capabilities:** no terminal attach,
  delivery acknowledgement or state events. **I/O:** one byte stream;
  tmux control output on a private socket, reusing the production key
  allowlist, send arguments and shell-prompt check without changing them.
  **Isolation:** canonical temporary registry path, separate fresh home per
  runner, fixed environment, no shell fallback. The fixture emits a shell
  prompt as data, never a command interpreter. **Lifecycle:** input closes
  before stop; graceful uses SIGTERM with a short SIGKILL deadline, kill
  uses SIGKILL, and natural exit also kills the process group. Linux tests
  verify that live descendants disappear; already-dead zombies are left to
  the OS reaper. **Platform evidence:** Linux only; no evidence or support
  claim for other platforms in this slice.
- Deviations and limits: no production changes or scope deviations. Local
  Linux validation uses an offline scratch build of the pinned native addon
  because the installed copy has no binding. The sandbox blocks the Unix
  socket needed by tmux; CI must prove that half of the contract. No real CLI
  conformance run or install was attempted. The production build, server
  entry and gated send action work with node-pty resolution denied, without
  opening a listener.
- Local verification: typecheck, dependency boundaries, licence and diff
  checks passed. Ten new PTY and isolation tests passed; seven tmux contract
  cases could not use their private socket. The existing suites were attempted
  but did not pass in the sandbox, including blocked subprocesses in base
  and blocked subprocesses or loopback sockets in Deck. Deck did not reach
  a summary; a bounded retry excluding the socket suites also timed out. The
  leak gate stopped before scanning with `spawnSync git EPERM`.
- Supersedes: nothing, additive.
- Commits: pending maintainer commit.
