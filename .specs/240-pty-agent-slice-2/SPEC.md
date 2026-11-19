# #240: Run one opted-in Claude agent on the PTY runner

- Issue: #240 (child of #153, tracked by #225)
- Branch: `pty-slice-2`
- Started: 2026-11-19
- Status: In progress.

## TL;DR

Slice 1 proved `Runner`, `PtyRunner` and `TmuxRunner` against a fixture, under `packages/deck/test/runner/`. This slice runs ONE real Claude Code agent on `PtyRunner`: an agent the operator opts in, in a fresh session Deck starts, with Deck's send route, message push and thread terminal view going through the runner for that agent only. Every other agent stays on tmux, unchanged. Linux only.

## Scope

In this slice:

1. **Opt-in, two keys, both required.** Instance: `MC_PTY_RUNNER=1` (default off, read in `packages/deck/app/lib/instance.server.ts` beside `tmuxEnabled`). Agent: `$AGENTS_HOME/<agent>/.runner` containing `pty`, the same per-agent file convention as `.runtime` and `.model` (`packages/base/bin/runtime-launch.sh`, `packages/deck/app/lib/agent-model.server.ts`). Only `.runtime` = `claude` (or absent) qualifies. At most one running PTY agent per instance.
   Verify: unit tests for every combination; any other value means tmux.
2. **Production runner module.** Move the interface and shared lifecycle from `packages/deck/test/runner/runner.ts` (former slice 1 path) to `packages/deck/app/lib/runner/runner.ts`; add `packages/deck/app/lib/runner/pty-runner.server.ts` with a launch spec (command, args, cwd, env) replacing fixture scenarios. PTY readiness becomes "spawned and produced output within 10 s", not `FIXTURE READY`. Process group kill, typed `LaunchFailure`, write refused after exit: all kept. Fixture tests reuse the same base.
   Verify: slice 1 contract suite against both runners, plus PTY readiness without a marker and silent-session cleanup.
3. **Session registry** `packages/deck/app/lib/runner/registry.server.ts`, the only production importer of `PtyRunner` (import-graph test updated to say so). One `globalThis` map per Deck process, so a dev reload cannot create a second. Lock file `$AGENTS_HOME/<agent>/.runner.lock` created exclusively: Deck pid, child pid, session id, start time.
   Verify: second start refused; start refused while a tmux window of that name is live (`listTmuxWindows` in `packages/deck/app/lib/tmux.server.ts`); stale lock with dead pid is reclaimed only after the group is confirmed gone.
4. **Launch real Claude or a stub.** Command `claude --session-id <fresh UUID> -n <agent>`, cwd the agent home, environment an explicit allowlist (`HOME`, `PATH`, `TERM`, `LANG`, `USER`, `CLAUDE_CONFIG_DIR`, `MC_PTY_RUNNER` if set), the resolved `AGENTS_HOME` and the agent's `INBOX_ROOT`. No other `MC_*` values or tokens from Deck's env. The fresh id is stored in the lock, never in `.session-id`, so tmux can resume the old conversation on the way back. Tests inject the stub (`packages/deck/test/runner/fixture-agent.mjs`) through the registry constructor, never through env or a file.
   Verify: env snapshot test; stub launch end to end.
5. **Start, stop, interrupt.** `packages/deck/app/routes/api.runner.tsx`: POST `{agent, op: start|stop|cancel}`, `requireSameOriginWrite` as in `packages/deck/app/routes/api.tmux-send.tsx`, refused unless opted in. No auto-restart.
   Verify: route tests for each op and each refusal.
6. **Screen buffer.** `@xterm/headless` fed from `output()`, scrollback 1000 lines (matches `TMUX_CAPTURE_SCROLLBACK_LINES`), memory only, never written to disk or logs.
   Verify: fixture output renders the same text the fixture drew.
7. **Send route and push.** `packages/deck/app/routes/api.tmux-send.tsx`: for a PTY-owned agent, run `submitPaneText` (`packages/deck/app/lib/tmux-submit.ts`) with a `PaneSubmitDriver` whose `capture` classifies the screen buffer via `classifyPaneSnapshot`, and whose `sendText`/`pressEnter` call `runner.write` / `runner.key("Enter")`. If the buffer cannot yield SGR for ghost detection, composer is `unknown` and the send fails closed. `packages/deck/app/routes/threads.$agent.tsx` `wakeTarget` and `pushTarget` take the same branch. Named keys go to `runner.key`.
   Verify: driver tests with the fixture's composer, paste placeholder and confirmation-dialog shapes; exact payload asserted.
8. **Terminal view.** The loader's `captureTmuxPane` call becomes a snapshot from the screen buffer for PTY agents. `packages/deck/app/components/TmuxPane.tsx` keeps polling; no WebSocket, no new stream.
   Verify: loader test; manual try.
9. **Exit and quiet.** On `exited()`: lock removed, exit code and time kept in memory, view shows "stopped (code N)", sends refused with a typed reason. "Quiet" = alive, no output for 10 minutes after an unanswered write: shown only, no action.
   Verify: stub exits 23; stub hangs.
10. **Deck shutdown.** `packages/deck/server/production.mjs` on SIGTERM/SIGINT: `stop("graceful")` for all sessions. On Deck start, a stale lock's group is killed and the agent shown stopped. Restart survival is out.
    Verify: kill Deck with the stub running; no descendant remains.
11. **Base script guards.** `packages/base/bin/inbox-push`: an opted-in recipient is not pushed; exits with a distinct persisted-not-pushed status. `packages/base/bin/boot-agents.sh`, `packages/base/bin/workspace.sh`: skip opted-in agents with a log line. `packages/base/bin/codex-provider-switch`: refuse.
    Verify: base tests with `.runner` present and absent, plus a PTY child running `inbox reply` against a marked recipient with a stubbed live tmux window.

Not in this slice: more than one PTY agent; Codex or Antigravity on PTY (ACP, #154); browser keystroke streaming or WebSocket; resuming an existing conversation on PTY; restart survival; delivery acknowledgement from hooks; sweeps, activity and cron agent-mode rewired (they find no window and do nothing; documented); macOS and Windows; changing the default runner; authentication.

## Drained cutover for one agent

First try on a scratch agent (`packages/base/bin/create-agent.sh`), which has nothing to drain. For an existing agent:

1. Stop admission: write `.runner`. Deck and `inbox-push` now persist only.
2. Settle: operator sees the tmux pane idle and closes its window.
3. Ownership: start refuses while the window is live or a lock is held.
4. Start on PTY. Way back: stop, delete `.runner`, `packages/base/bin/boot-agents.sh` resumes the untouched `.session-id` on tmux.

## Risks

| Risk | Mitigation |
| --- | --- |
| Input to the wrong place | Writes only to the registry's own child; refused after exit; fail-closed composer check; no shell fallback |
| Orphaned processes | Own process group; group kill on stop, exit and Deck shutdown; stale-lock sweep on start; test with a SIGTERM-ignoring descendant (slice 1) |
| Two processes on one conversation | Fresh session id; exclusive lock; tmux-window check; boot scripts skip opted-in agents |
| Secrets in terminal output | Buffer in memory only; served through the existing same-origin, `tmuxEnabled` loader; no worse than tmux capture today; Deck secrets never in child env |
| Windows, macOS | Runner refuses non-Linux with a typed `unavailable`, as in slice 1 |
| Resource use | One session; 1000-line buffer; output stream drained continuously; node-pty stays optional and lazy |
| node-pty missing | Opt-in shows "unavailable: <reason>"; tmux unaffected |

## Acceptance

- Opted-in stub agent: start, send, see output, cancel, stop, exit 23 shown, no descendants, all in CI.
- Non-opted agents: existing Deck and base suites pass unchanged.
- In production, `PtyRunner` imported only by the registry; no listener opened.
- Real Claude conformance note recorded for the version tried.

## Test plan

- For build step 1, run `pnpm -C packages/deck test test/runner`,
  `pnpm typecheck`, and `pnpm check:boundaries`. Run the repository licence,
  library version, dash, whitespace and leak checks.
- For build step 2, run the same checks. The registry tests inject the stub
  harness, mock tmux, and exercise both production shutdown signals without
  binding a port.
- Later steps add the automated checks listed in Scope. The manual try below
  requires those steps to be complete; do not run it for step 1.

### Manual try script (maintainer)

From the repository root:

```sh
git switch pty-slice-2 && pnpm install
packages/base/bin/create-agent.sh ptytest
echo pty > "$AGENTS_HOME/ptytest/.runner"
MC_PTY_RUNNER=1 pnpm -C packages/deck start
```

1. Open `/threads/ptytest?view=tmux`, press Start. See Claude's welcome screen within 10 s.
2. Type "say hello" in the compose box. See it typed and answered.
3. Send a chat message from the thread view. See it arrive in the terminal.
4. Press Interrupt mid-answer. See the turn stop.
5. `pgrep -af claude` shows one process for ptytest; `tmux ls` shows no ptytest window.
6. Stop Deck with Ctrl+C. `pgrep -af claude` shows none for ptytest.
7. Other agents: send to one on tmux; behaves as before.

## Build plan

1. **Promote the runner** (item 2, import-graph update). Verify: contract suite green, typecheck.
2. **Registry, opt-in, lock, env, stub launch, exit, shutdown** (items 1, 3, 4, 9, 10). After 1. Verify: registry tests with the stub, descendant check.
3. **Base script guards** (item 11). Parallel with 1 and 2; touches only `packages/base`. Verify: base suite.
4. **Routes and view** (items 5 to 8). After 2. Verify: route, driver and loader tests; manual try steps 1 to 4.
5. **Real Claude run and SPEC close-out**: conformance note, docs line in `docs/adding-an-agent.md`, Log. After 3 and 4. Verify: full manual try.

## Decisions

1. Yes: `.runner` file plus `MC_PTY_RUNNER`; matches `.runtime`.
2. Yes: fresh session only, old `.session-id` untouched; resume on PTY next slice.
3. Yes: add `@xterm/headless` (MIT) in build step 4; raw bytes cannot be classified.
4. Yes: Deck restart kills the PTY agent; no survival.
5. Yes: reuse the "sent, could not confirm" UI wording when verification is unavailable; no `packages/deck/app/components/TmuxPane.tsx` change.

## Follow-ups

- Complete build step 5 after installing the declared screen dependency and
  regenerating the lockfile. Run the stub screen tests before the maintainer's
  manual try.

## Log

### 2026-11-19: Draft written
- What changed: private draft from slice 1 SPEC, runner code and touch points.
- Supersedes: nothing.
- Commits: none.

### 2026-11-19: Prepare #240 and start build step 1
- What changed: Put the draft in public SPEC format and marked planned paths.
- Why: Establish the scope before changing the runner. Later build steps stay
  in this issue, but are not part of the promotion patch.
- Commits: pending

### 2026-11-19: Promote the runner (build step 1)
- What changed: Moved the runner interface, shared lifecycle and PTY adapter
  into the application library. PTY launch takes a command, args, cwd and env
  and waits up to 10 seconds for non-empty output. The fixture registry still
  constructs its own commands and homes. Import checks keep fixtures out of
  production and reserve the PTY adapter for the future registry.
- Why: The plan promotes the shared code and PTY adapter only. The tmux
  adapter stays test-only and keeps its readiness marker, so diagnostics from
  the fixture wrapper cannot count as readiness. A missing PTY executable
  now fails before spawn because node-pty can write an exec diagnostic to
  the terminal; there is no child exit code in that case. First output does
  not prove application readiness beyond the stated PTY contract.
- Validation: Runner suite passed 28 tests with `CI=1`. The sandbox denied
  private Unix sockets, so the live tmux fixture was skipped; mocked tmux
  tests passed. Typecheck, boundaries, licence, library version and whitespace
  checks passed. Both default leak checks hit `spawnSync git EPERM`; the
  explicit working-tree file scan passed. The dash check timed out; a direct
  full-tree scan found no banned dashes.
- Commits: 523d594 refactor(runner): promote the runner out of tests for slice 2 (#240)

### 2026-11-19: Pick up build step 2
- What changed: Confirmed the five decisions and picked up the registry and
  production lifecycle after the runner promotion.
- Why: Keep the stub-only lifecycle work separate from send admission, screen
  rendering and a live conformance try. The drained cutover still requires
  the later script and route guards.
- Commits: pending

### 2026-11-19: Implement the registry and lifecycle (build step 2)
- What changed: Added the process-wide registry, two opt-in checks, exclusive
  lock, allowlisted launch, quiet and exit state, startup recovery and graceful
  shutdown. The production launcher forwards shutdown signals to the server.
  Output is drained without storage until the screen buffer step.
- Why: Use `AGENTS_HOME` first, falling back to Deck's existing `AGENTS_ROOT`
  convention. Take `INBOX_ROOT` from the agent's Claude settings, or its
  `.inbox-root` if not set there; never substitute Deck's root. The PTY library
  supplies `PWD` from the launch directory, not from Deck's environment.
  A failed tmux probe that cannot prove absence refuses launch. Recovery uses
  a separate exclusive guard and records Linux boot and process birth IDs to
  avoid reclaiming a new owner's lock or killing a reused PID. Incomplete
  locks and live groups without a verifiable leader stay locked and block
  PTY starts; operator verification is required before removing the lock, any
  abandoned recovery guard, and restarting. A group with no live members can
  be reclaimed.
- Validation: 84 focused tests passed, including no-descendant checks on
  SIGTERM and SIGINT; 10 private tmux tests were skipped by the socket sandbox.
  The offline build, typecheck, boundaries, licence, library version, dash and
  whitespace checks passed. Default leak commands hit `spawnSync git EPERM`;
  the explicit working-tree file scan passed.
- Commits: 3293d06 feat(runner): PTY registry, opt-in, lock, launch environment and shutdown cleanup (#240)

### 2026-11-19: Guard base scripts (build step 3)
- What changed: `inbox-push` returns `skip:pty-runner` with exit 2. Boot and
  workspace log and skip PTY targets before using tmux or changing their
  session files. The provider switch refuses a PTY target at validation.
- Why: Use the existing persist-only exit code with a distinct verdict, so the
  inbox retains the full message without waking a draining tmux pane. The
  guards use the instance flag and on-disk agent settings, not a launch
  override or a live lock, so they also work before the first PTY start.
- Commits: 0412b72 feat(base): skip and refuse PTY-runner agents in boot, push and provider switch (#240)

### 2026-11-19: Route the opted-in terminal (build step 4)
- What changed: Added same-origin PTY lifecycle controls, an in-memory
  `@xterm/headless` screen, and registry-backed terminal capture, sends,
  inbox wakes and pushes. Reused the existing terminal component, submit
  policy and message payloads. The registry still refuses a live tmux window
  with the same name.
- Why: Opted-in agents persist to the inbox without waking tmux until PTY
  starts. A live PTY or lock also blocks tmux fallback if opt-in is removed
  early; stop first, then remove the marker. The existing terminal gate
  still applies. Automatic text delivery requires bracketed paste, a framed
  Claude composer with known dim styling, and an exact visible match before
  Enter. Opaque paste placeholders and changed dialogs are left untouched
  after paste; the operator can inspect and use a named key intentionally.
  Sends are bound to their original session and never replayed into a restart.
- Dependency: Declared `@xterm/headless` 5.5.0 (MIT). Offline resolution failed
  because pnpm has no cached metadata for it, so the lockfile is unchanged.
  Without the dependency PTY start is refused before spawning. No live agent
  was started.
- Validation: 181 focused tests passed serially, 25 skipped (including the
  four headless integration tests). Typecheck, boundaries, licence, library
  version, direct dash and whitespace checks passed. Leak scripts hit
  `spawnSync git EPERM`; the explicit working-tree file scan passed.
- Commits: 5bec1b0 feat(runner): route send, push and terminal view through the PTY runner for opted-in agents (#240)

### 2026-11-19: Keep PTY replies persist-only during cutover
- What changed: Pass `MC_PTY_RUNNER` and the resolved `AGENTS_HOME` to the
  PTY child without forwarding secrets. Add a regression test that runs
  `inbox reply` in the child. Move this SPEC to `.specs/240-pty-agent-slice-2/`;
  #240 continues the work started in #153.
- Why: PR #241 review found that `inbox-push` skipped the PTY guard without
  the flag and needs the agent root to find the recipient's `.runner`.
  The SPEC folder now matches the issue it tracks.
- Supersedes: The earlier child environment allowlist; the opt-in is unchanged.
- Commits: pending
