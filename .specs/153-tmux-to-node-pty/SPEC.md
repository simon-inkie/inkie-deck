# #153: Replace tmux with a cross-platform node-pty runner

- Issue: https://github.com/simon-inkie/inkie-deck/issues/153
- Branch: docs/node-pty-acp-spec (planning only; the build branch will be
  `153-<slug>`)
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

Deliverable of this slice: a table in this SPEC listing every place a later
live change would touch, what it reads or writes today, and whether a
later change would replace, guard or retire it. Starting list:

- Delivery: `packages/base/bin/inbox-push`; `packages/deck/app/routes/api.tmux-send.tsx`;
  the wake and push paths in `packages/deck/app/lib/tmux.server.ts`;
  `app/lib/tmux-submit.ts`.
- Stuck detection: `packages/base/bin/stuck-pane-sweep.sh`,
  `packages/base/bin/pane-idle`.
- Metrics and activity: `packages/base/bin/activity-sweep.sh`,
  `app/lib/activity.shared.ts` and the activity panel, context and quota
  readers.
- Streaming and view: `app/components/TmuxPane.tsx`, `app/routes/tmux.tsx`
  and their polling.
- Boot and lifecycle: `packages/base/bin/boot-agents.sh`, `workspace.sh`,
  `claude-session.sh`.
- Scheduling: `app/lib/cron.server.ts`.

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
