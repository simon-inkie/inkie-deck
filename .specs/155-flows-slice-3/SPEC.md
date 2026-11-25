# #155: Deck Flows Slice 3 (Library, Worktrees, Fixture Adapters, Checks, and Minimal UI)

- Issue: https://github.com/simon-inkie/inkie-deck/issues/155
- Branch: `155-flows-slice-3`
- Started: 2026-11-25

## TL;DR

Connect the landed Slices 1a, 1b, and 2 SQLite flow engine (`#246`) to real coding-flow mechanics so Example A (`ticket-to-pr`) runs end to end on the existing 153 (PTY) and 154 (ACP) scripted fixtures without mocking away the workspace, checks, or approval gate:
1. Extend strict public schemas for Example A check IDs and outputs, and add a file-based flow library (`<project>/.deck/flows/` -> `<deck-data>/flows/library/` -> built-in `flows/library/ticket-to-pr.yaml`) with draft creation and unified template diffing.
2. Split `planRun` (`run_planned` + `pinned_flows`) and `approveRun` (`flow_approved { flowHash, actorId }`) so unapproved runs cannot start and approval stays an explicit run event (preserving future CLI compatibility).
3. Add ephemeral git worktree isolation (`git worktree add`) per coding attempt with clean rollback (`git worktree remove --force` + `git worktree prune`) on failure, timeout, or crash.
4. Add a runtime-neutral `FlowStepAdapter` seam wired to the existing 153 PTY (`PtyRunner`) and 154 ACP (`AcpSession`) fixture harnesses with `roles.<name>.runtime` dispatch and `differs_from` enforcement.
5. Add a deterministic check runner (`typecheck`, `test`, `lint`, `leak_scan`, `build`, `repro` fail-on-base/pass-on-head) and git-diff signal extraction (`changedFiles`, `protected_path_touched`, `dependency_changed`, `files_changed_over`, `stale_sha`, `secret_found`, `test_weakened`) feeding `evaluateStepJudgement`.
6. Add a minimal same-origin-gated choose/draft-diff/approve/start panel on `/flows` backed solely by the event-driven `planRun`/`approveRun`/`runFlow` library functions.

## Scope

In scope:
- Built-in flow library (`flows/library/ticket-to-pr.yaml`) and `packages/deck/app/lib/flows/library.server.ts`.
- Schema extensions in `packages/deck/app/lib/flows/types.ts` and `validator.ts` (strict allowlists, zero free text).
- Split `planRun` and `approveRun` in `packages/deck/app/lib/flows/store.server.ts` and `runner.server.ts`.
- Ephemeral worktree manager in `packages/deck/app/lib/flows/worktree.server.ts`.
- Runtime-neutral step adapter seam in `packages/deck/app/lib/flows/adapter.server.ts` (153 PTY + 154 ACP fixtures).
- Deterministic check runner and git-diff signal extractor in `packages/deck/app/lib/flows/checks.server.ts`.
- Minimal same-origin-gated UI and API actions in `packages/deck/app/routes/flows.tsx`, `packages/deck/app/routes/api.flows.tsx`, and `packages/deck/app/components/`.
- Unit, integration, and end-to-end Vitest suites in `packages/deck/test/flows/`.

Out of scope:
- Live LLM runtimes (Claude PTY, live `agy acp`, Codex ACP) and real `#179` model benchmark (Slice 3b).
- Git progress projection (`.deck/runs/<id>/events.jsonl`) and import (Slice 4).
- Node Inspector (xterm.js PTY / check log split panel) and subreaper/cgroup containment (Slice 3b).
- Pre-answers (Slice 5), light model judge and standing approval (Slice 6), cross-machine fence (Slice 7), child flows (Slice 3c), Deck CLI binary, and GitHub/Linear tracker sync (`#205`).
- Database-backed draft/library tables (deferred; approved file-based for Slice 3).

## Test plan

- `TMPDIR=/var/tmp pnpm -C packages/deck exec vitest run test/flows/`
  - Library precedence (`project` > `library` > `builtin`), path confinement, draft write, unified template diff, promotion, `ticket-to-pr.yaml` validation, and zero free-text privacy invariants.
  - Split `planRun` / `approveRun`: unapproved `runFlow` refused, mismatched `flowHash` refused, duplicate approval refused, exact hash approval runs and replays identically.
  - Ephemeral git worktree against a real `git init` repo: clean creation, commit capture on pass, full rollback (`git status --porcelain` empty, `git worktree list` clean) on fail/timeout/crash, clean rewind without dirty compounding.
  - `FlowStepAdapter` dispatching `agent` via 153 PTY fixture and `handoff` via 154 ACP fixture, `differs_from` enforcement, and zero leaked child PIDs on timeout.
  - Deterministic checks (`typecheck`, `test`, `lint`, `leak_scan`, `build`), `repro` fail-on-base/pass-on-head, and git-diff signals (`protected_path_touched -> decide`, `secret_found -> stop`, `test_weakened -> stop`, `stale_sha -> notify`).
  - End-to-end Example A (`ticket-to-pr`) running `intake` -> `build` -> `verify` (fail + clean rewind + repro pass) -> `review` (`changes` rewind -> `approve`) -> `ready` (`always: decide`, never pushes/merges), plus drafted custom flow diffed, approved, and run to `done`.
  - Minimal `/flows` UI and `/api/flows` POST actions: `requireSameOriginWrite` enforcement, flow picker, draft template diff preview, `Approve` (`flow_approved`), and `Start` action rendering cleanly without leaking `private_details`.
- Full repo gates: `pnpm typecheck`, `pnpm check:boundaries`, `pnpm check:leaks`, `pnpm check:licence`, `pnpm check:lib-version`, `pnpm -C packages/deck check:dashes`, `pnpm build`.

## Follow-ups

- Slice 3b: live runtimes (Claude PTY, live `agy acp`, Codex ACP), read-only Node Inspector, and subreaper/cgroup containment.
- Slice 4: git progress projection and read-only import.

## Log

### 2026-11-25: Create Slice 3 SPEC on branch 155-flows-slice-3
- What changed: added this SPEC capturing the approved Slice 3 plan (file-based library/drafts, split plan/approve, ephemeral git worktrees, 153/154 fixture adapters, deterministic checks + git-diff signals, and minimal `/flows` choose/draft-diff/approve UI).
- Why: establish the Slice 3 contract before implementation per `DEVELOPMENT.md`.
- Supersedes: nothing, additive.
- Commits: 401c1bc

### 2026-11-25: Implement Slice 3 Pass A + Pass B on branch 155-flows-slice-3
- What changed:
  - Pass A (`b52d174`): added `flows/library/ticket-to-pr.yaml`, `library.server.ts`, `worktree.server.ts`, `adapter.server.ts`, `checks.server.ts`, split `planRun`/`approveRun` in `store.server.ts` and `runner.server.ts`, and Slice 3 unit/e2e suites.
  - Pass B: extracted pure `diff.ts`, added `ui-actions.server.ts` seam (`listFlowLaunchCatalog`, `planFlowFromUi`, `approveFlowFromUi`, `startFlowFromUi`), added `GET /api/flows?view=library` and same-origin-guarded `POST /api/flows` intents (`plan`, `approve`, `start`), added `FlowLaunchPanel` + `FlowRunApprovalBar` on `/flows`, and added `slice-3-ui.test.tsx`.
- Why: complete the end-to-end Slice 3 choose, draft-diff, approve (`flow_approved`), and start loop on `/flows`.
- Supersedes: nothing, additive.
- Commits: `b52d174`, `bd7dd55`

### 2026-11-25: Pass 1 standard review fixes (R1-1 through R1-7)
- What changed: fixed `ReproTestCommand` `{ buildCommand }` dispatch (`checks.server.ts`), wrapped `handoffAdapter.dispatch` timeout/abort handling cleanly (`runner.server.ts`, `store.server.ts`), aligned `run: [repro]` and `repro:`-only checks (`checks.server.ts`, `store.server.ts`, `runner.server.ts`), passed `options.adapter` fallback into `resolveRoleAdapters` `differs_from` checks (`adapter.server.ts`, `runner.server.ts`), deferred `keepWorktreeBranch = true` until post-judgement pass (`runner.server.ts`), enforced `wtOutcome.isClean` and verified `wtOutcome.headSha` + git-diff signal precedence (`runner.server.ts`), and skipped malformed `.yaml` files in `scanFlowDirectory` while keeping symlink/confinement fail-closed (`library.server.ts`, `flows.tsx`). Added regression tests for all 7 items (152/152 tests passing).
- Why: resolve all 7 Pass 1 triage FIX items before Pass 2 verification.
- Supersedes: updates `b52d174` and `bd7dd55` in place.
- Commits: 183ef5f

### 2026-11-25: Pass 2 triage fixes (R1-2 and R2-1)
- What changed: updated `runner.server.ts` so `handoffAdapter.dispatch` timeout with `step_timeout: decide` returns `waiting_decision` even without `options.inbox`, and updated `flows.tsx` `loadCatalogSafely()` + `loader` to return sanitised HTTP 422 data on symlink/confinement failures without throwing raw host paths, with regression tests in `slice-3-adapter-checks.test.ts` and `slice-3-ui.test.tsx`.
- Why: resolve Pass 2 triage items R1-2 and R2-1.
