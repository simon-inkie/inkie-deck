# #155: Replay committed notify judgements to inbox on resume

- Issue: https://github.com/simon-inkie/inkie-deck/issues/155 (follow-up to #246)
- Branch: `155-flows-d7-notify-replay`
- Started: 2026-11-25

## TL;DR

If execution crashes at `K9_AFTER_JUDGEMENT` or an inbox write fails after a `judgement(notify)` event is durably committed to SQLite, resuming `runFlow` previously skipped the already-judged attempt and finished without delivering its inbox notice. This fix replays committed `judgement(notify)` events on resume using each judgement's ledger `(seq, hash)` and deterministic `actionId`, while preserving terminal run status and reporting replay errors explicitly if the inbox fails on an already completed run.

## Scope

In scope:
- Idempotent replay of committed `judgement(notify)` events in `packages/deck/app/lib/flows/runner.server.ts` when `runFlow` is called with `options.inbox`.
- Preserving terminal run status (`finished` / `stopped`) when inbox replay fails on an already terminal run, surfacing failures via `RunFlowResult.notifyReplayErrors` so delivery remains retryable.
- Regression tests in `packages/deck/test/flows/slice-2-handoffs.test.ts` covering `K9_AFTER_JUDGEMENT` (normal and K4 recovery), a fail-once `writeReply` error, and inbox read/write failures on a completed run.

Out of scope:
- New event types, SQLite schema changes, UI changes, or Slice 3 work.
- Inbox decision-card supersession race (tracked separately).

## Contract

1. **Deterministic replay on resume:** When `runFlow` runs with `options.inbox`, scan committed `judgement` events with `data.final === "notify"` in ledger order and invoke `emitNotifyCardToInbox` with each event's ledger `seq`, ledger `hash`, `stepId`, derived `occurrence`, `reasonCode`, and deterministic `buildDeterministicNotifyCardId(runId, stepId, occurrence, reasonCode)`.
2. **Idempotency:** `emitNotifyCardToInbox` checks existing inbox blocks by `actionId`; resuming twice produces exactly one notice card per `(runId, stepId, occurrence, reasonCode)`.
3. **Terminal status preservation and retryability:** On a non-terminal run, an inbox replay error propagates so the caller retries before advancing. On an already terminal run (`finished` or `stopped`), replay errors are caught per judgement and returned in `RunFlowResult.notifyReplayErrors` without masking `finalStatus`, `terminalOutcome`, or `terminalReason`. Because no delivery marker is written on failure, a later `runFlow` call retries delivery cleanly once the inbox recovers.

## Test plan

- `TMPDIR=/var/tmp pnpm -C packages/deck exec vitest run test/flows/`
  - Interrupt at `K9_AFTER_JUDGEMENT`, resume twice -> exactly 1 notice card with the judgement's ledger `seq` and `hash`.
  - Interrupt at `K4_AFTER_OUTCOME` then `K9_AFTER_JUDGEMENT` during recovery, resume twice -> exactly 1 notice card with the recovery judgement's `seq` and `hash`.
  - Fail `writeReply` once on initial run, then resume twice -> exactly 1 notice card with exact `seq` and `hash`.
  - Completed run with existing notice + failing `readBlocks` -> returns `finished` / `done` with `notifyReplayErrors` (does not reject); retry after recovery clears `notifyReplayErrors` with 1 card.
  - Completed run with missing notice + failing `writeReply` -> returns `finished` / `done` with `notifyReplayErrors`; retry after recovery delivers the 1 notice card and clears `notifyReplayErrors`.
- `pnpm typecheck`, `pnpm check:boundaries`, `pnpm check:leaks`, `pnpm check:licence`, `pnpm check:lib-version`, `pnpm -C packages/deck check:dashes`, `pnpm build`.

## Follow-ups

None.

## Log

### 2026-11-25: Initial notify replay fix and K9 tests (retrospective)
- What changed: added `replayCommittedNotifyCards` in `runner.server.ts` and K9 / K4+K9 double-resume regression tests in `slice-2-handoffs.test.ts`.
- Why: close the crash/write-failure gap after durable `judgement(notify)` commits.
- Supersedes: nothing, additive.
- Commits: f531ac3 fix(flows): replay committed notify judgements to inbox on resume (#155)

### 2026-11-25: Address PR #247 review findings (SPEC, writeReply failure test, terminal status preservation)
- What changed: added this SPEC, preserved terminal `RunFlowResult` with explicit `notifyReplayErrors` on terminal-run inbox replay failures, and added fail-once `writeReply` and terminal-run inbox failure regression tests.
- Why: satisfy the repository SPEC requirement, test rejected `writeReply` recovery directly, and ensure inbox read/write failures never mask a completed run's terminal status while keeping notice delivery retryable.
- Supersedes: updates `replayCommittedNotifyCards` terminal-run error handling from `f531ac3`.
- Commits: pending
