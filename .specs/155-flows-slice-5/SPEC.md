# #155: Flows slice 5, pre-answers at planning

- Issue: #155
- Branch: 155-flows-slice-5-pre-answers
- Started: 2026-11-28

## TL;DR

The planning card lists predictable decisions and their choices. After approving
the pinned flow, an operator can save or replace a choice before Start. The
runner can use the latest choice for the first eligible occurrence and shows
the recorded result in the stream.

## Scope

- **F1.** Plan from the pinned definition. List explicit decisions and
  potential rule and limit exits that ask for a decision. Show the same options
  that a live decision would offer. Conditional choices are checked again when
  the question opens. An agent or check can ask at the default limits as well
  as at custom limits. Hard stops have no planning choices. Show
  `always: decide` questions as live-only.
- **F2.** The order is explicit exact-hash approval, optional pre-answers, then
  Start. `POST /api/flows` accepts the same-origin JSON intent `preanswer`
  with `projectId`, `runId`, `flowHash`, `stepId` and `choiceKey`.
  The server resolves the choice from the approved pin and records the human
  actor. The shared append rule requires approval and a run that has yet
  to start. Imported history is read-only.
- **F3.** A run-level `preanswer_given` records bounded `stepId` and
  `choiceKey` values and the server-assigned `actorId` in its payload. The
  approved hash and run envelope bind it to the pin. The latest event for
  the step supersedes earlier saves. An answered `handoff_returned` with
  optional positive integer `preanswerSeq` records the exact save used. The
  runner appends it after `handoff_sent`, before posting a live card, then
  uses the existing settlement path. Resume after either append uses the
  recorded facts.
- **F4.** Apply only to an actual decision at recorded occurrence 1, with a
  choice still offered and budget remaining. An explicit decision opens
  directly. An escalation needs the recorded `decide` judgement for the
  active attempt. `always: decide` and later occurrences use the live path.
  The live path also handles a decision at zero remaining steps or tokens,
  or a saved rewind choice at the rewind ceiling.
  Existing `continue`, `notify` and `stop` transitions remain authoritative.
- **F5.** The stream shows the latest saved choice and any recorded use as
  distinct statuses. Append and import share the same rules for verifying
  a marked return against the active handoff and latest save. Both event
  payloads use strict allowlists. Existing ledger lines remain valid. Slice
  4's explicit projection and read-only import carry the recorded use.

## Test plan

- `pnpm -C packages/deck exec vitest run test/flows/slice-5-ui.test.tsx`
  covers the pinned catalogue, saved and applied status after reload, approval,
  origin, wrong-pin and import guards.
- `pnpm -C packages/deck exec vitest run test/flows/slice-5-preanswers.test.ts`
  covers replacement, crash recovery, repeated and live-only decisions, the
  ceiling and outcome guards, and canonical projection and import.
- Run the Flows suite and repository gates on the checkpoint. Probe the
  catalogue, approval, origin, latest-choice, eligibility, stream and
  sequence checks individually, then restore each edit.

## Follow-ups

- R1-1: A crash between `handoff_sent` and the marked return shows live buttons. Append the marked return in the same chained batch or narrow the F3 resume sentence.
- R1-3: Saving a pre-answer is last-write-wins on retry. Send the expected saved sequence and refuse if the latest differs.
- R1-4: Require `step_started` occurrence to equal `max + 1` in the transition rule.
- R1-5: Add isolated refusal tests for saves after Start, non-human actors, return choice and resolution mismatches, and token and rewind ceilings.

## Progress log

### 2026-11-28: Define planning and application

- Recorded the planning, event, route and import contracts before implementation.

### 2026-11-28: Connect planning to the decision ledger

- Added the pinned catalogue, guarded save, crash-safe consumption and stream
  status. The stream exposes the richer catalogue in `planningDecisions`.
- Added fixture coverage for the planning controls, replay, live fallbacks
  and forged projection references. The projection fixture uses the
  canonical exporter and the real importer.

### 2026-11-28: Prove the planning and return guards

- 154 selected tests passed, including both slice 5 fixture suites.
  Each of the ten one-line probes failed its intended assertion, and each
  edit was restored exactly.
- Type checking, the build, the dependency boundary check and the licence
  check passed. The direct dash scan found no matches. The full host gate
  and browser walkthrough are pending.
