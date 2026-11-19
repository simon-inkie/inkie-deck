# #222: Check request origins on agent write routes

- Issue: https://github.com/simon-inkie/inkie-deck/issues/222
- Branch: origin-checks-agent-routes
- Started: 2026-11-19

## TL;DR

Reuse the Nudges origin and Host checks before Deck sends terminal input or
writes to threads, agent settings, project cards or workspace drafts. Keep
same-origin browser access through trusted tunnels and direct loopback scripts
working without changing Nudges' stricter remote admin policy.

## Scope

In scope:
- Guard `/api/tmux-send`, `/threads/:agent`, `/`, `/api/agent-model`,
  `/projects` and `/api/drafts` before any write, upload or terminal call.
- Guard the chat loader's inbox read receipt as well as the thread action.
- Approve loopback, the configured bind host and explicitly listed extra
  hosts. Check fetch metadata and match any Origin against Host, not the
  server-side URL or forwarding headers.

Out of scope:
- Changes to Nudge permissions, read routes, data-only actions or authentication.
- Live agent, terminal, tunnel or browser-server testing.

## Test plan

- Exercise the route actions with stubbed tmux and side effects. Check 403
  before side effects for cross-site, same-site, mismatched Origin and an
  unapproved Host. Check same-origin browser writes, including via an
  approved proxy host, and direct header-less loopback writes.
- Verify that chat navigation still returns 200 without writing a receipt
  when the write checks fail, including over plain HTTP on an approved LAN
  host with neither browser header. Verify that allowed requests still mark
  the thread read.
- Run the touched Vitest files and Nudge tests:

  ```sh
  pnpm -C packages/deck exec vitest run test/request-origin-routes.test.ts \
    test/tmux-send.test.ts test/threads-compose-subject.test.ts \
    test/thread-pane-hints.test.ts test/agent-model.test.ts test/drafts.test.ts \
    test/api-cron.test.ts test/scheduler-route.test.ts test/cron.server.test.ts \
    test/cron-validate.test.ts
  ```

- Run `pnpm typecheck`, `node scripts/leak-gate.mjs`, `pnpm check:leaks`,
  `node packages/deck/scripts/check-dashes.mjs`, and `git diff --check`.

## Follow-ups

None.

## Log

### 2026-11-19: Trace write actions
- What changed: Identified terminal sends, thread actions (including uploads),
  home action-card writebacks, model settings, projects and drafts. Scheduler
  and the cron API already use the Nudge guard.
- Why: Drafts already check a voice origin allowlist, but the request also
  needs an approved Host and matching Origin. Keep additional write hosts
  separate from the remote cron opt-in so tunnels do not enable cron admin.
- Supersedes: nothing, additive
- Commits: pending

### 2026-11-19: Guard the chat receipt and document proxy hosts
- What changed: Applied the guard to the chat loader before marking messages
  read. Terminal view still does not write receipts. Added MC_ALLOWED_HOSTS
  for tunnel names and documented that a proxy must preserve Host.
- Why: The chat loader writes outside DATA_ROOT even on GET. The UI's form
  actions and fetch URLs are relative to Deck, so they remain same-origin.
- Supersedes: nothing, additive
- Commits: pending

### 2026-11-19: Verify the route matrix
- What changed: Targeted Vitest run passed 495 tests with 11 skipped. Both
  leak scans, the direct dash scan, typecheck and diff checks passed.
- Why: Route tests stub tmux and verify rejected requests never reach a write.
  Validation used closed stdin and file-backed capture for sandboxed child
  processes that could not use Node's default sync subprocess pipes.
- Supersedes: nothing, additive
- Commits: 4a406e7 fix(security): same-origin and host checks on routes that write to agents (#222)

### 2026-11-19: Keep chat navigation readable without origin proof
- What changed: The chat loader skips the read receipt when the write checks
  fail and still serves the thread. Explicit write actions still return 403.
- Why: The PR review found that browsers can omit both Origin and fetch
  metadata on plain HTTP LAN navigation, even when the Host is approved.
- Supersedes: Guard the chat receipt and document proxy hosts (loader refusal only)
- Commits: pending
