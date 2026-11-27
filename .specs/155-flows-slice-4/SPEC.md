# #155: Deck Flows Slice 4 (Git progress projection and read-only import)

- Issue: #155
- Branch: `155-flows-slice-4-and-acp-followups`
- Started: 2026-11-26

## TL;DR

Export a run's verified public event ledger to `.deck/runs/<run-id>/events.jsonl`
in the project checkout. A second machine can explicitly import the history
into its local SQLite store for inspection. Git carries the file when the
operator commits it.

## Scope

- Same-origin `POST /api/flows` intents `project` and `import`, each taking
  `projectId` and `runId`. The checkout is the configured
  `FLOWS_PROJECT_ROOT`. Use the existing project ownership lock for both.
- Projection writes canonical SQLite line bytes in sequence order with LF
  terminators. Both the existing file and any ledger in Git HEAD must be
  byte-for-byte prefixes. An identical projection is a no-op.
- Import accepts bounded, canonical UTF-8 JSONL within the selected run
  directory. Validate the run ID, sequence, hash chain, exact flow pin,
  event schema and transition grammar. Count rejected lines and refuse the
  entire import if any fail. Identical or older prefixes are no-ops. A valid
  extension is inserted atomically and a divergent history is refused.
  A successful extension makes that local run read-only.
- Resolve the exact flow definition from the existing library lookup or a
  separately supplied, structurally valid `.deck/runs/<run-id>/flow.yaml`.
  Projection publishes only the event ledger. Private details, raw workflow
  text and artefact payloads stay out of the projection. Artefact events
  are historical records on import and do not supply executable inputs.
- Imported runs are persistently read-only. Inspection uses the recorded
  history. Starting, approving or answering an imported run is refused.

## Out of scope

- Automatic projection, Git staging or commits, push, quarantine, automatic
  checkout import, cross-machine execution or fencing, and new launch controls.

## Test plan

- Run `pnpm -C packages/deck exec vitest run test/flows/slice-4-projection.test.ts`.
- Check exact byte order, append and no-op behaviour, and refusal to rewind
  a committed ledger. Import into a separate SQLite store and verify
  idempotence, atomic rejection and the execution guard.

## Local use

Set `FLOWS_PROJECT_ROOT` to the repository root. Send the following JSON
body to the local Deck `POST /api/flows` endpoint with a same-origin header.

```json
{"intent":"project","projectId":"example-project","runId":"example-run"}
```

Commit the resulting ledger to carry it to the other checkout. Use the
same body with `"intent":"import"` there. Import needs the identical
definition bytes from the flow library or a supplied `flow.yaml` alongside
the ledger. Open the run under `/flows` to inspect the imported history.

## Log

### 2026-11-26: Define the projection and import contract

- What changed: specified the API, canonical ledger and SQLite import
  boundaries before implementation.
- Why: build the Slice 3 follow-up with the existing append grammar and
  project lock. Keep the operation explicit and keep raw definitions out
  of automatic publication.
- Supersedes: nothing, additive.
- Commits: working tree.

### 2026-11-26: Implement and verify the explicit actions

- What changed: projection preserves the existing prefix and installs the
  complete file atomically. Import reuses the append grammar and checks
  named artefact evidence against the recorded receipts and pinned
  definition. It records a persistent read-only marker in the same transaction.
- Why: maintain the local ownership and execution boundary while exposing
  the recorded progress on another machine. Limit input to 8 MiB and 10,000
  event lines and limit external pinned definitions to 1 MiB.
- Verification: four new projection tests, eleven Flows UI tests and eight
  store tests passed. Flows fixtures used a temporary directory outside the
  sandbox's Git-marked default temporary root.
- Supersedes: nothing, additive.
- Commits: working tree.
