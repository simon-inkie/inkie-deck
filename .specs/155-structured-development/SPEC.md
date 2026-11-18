# #155: Epic: structured task flows, source tickets and durable runs

- Issue: #155 (https://github.com/simon-inkie/inkie-deck/issues/155). The
  published body is copied in [ISSUE-TEXT.md](ISSUE-TEXT.md).
- Branch: docs/structured-dev-spec (planning only; no code)
- Started: 2026-11-18
- Scope of this file: phase 1 only. Nothing here is built, tested or
  decided; every check and acceptance item below is proposed future work.
- Related, with no phase 1 prerequisite: #152 (plugin system), #153 (a
  cross-platform node-pty runner) and #154 (Agent Client Protocol sessions
  and events). #153 and #154 are independent of each other, and neither
  alone promises typed live events or session continuity to this epic.

## TL;DR

Phase 1 proposes a small native flow engine in Deck. A person starts one
generic flow, locally, for one ticket. The flow claims the ticket's board
card, runs one bounded agent step through a runtime-neutral adapter, checks
the result deterministically, and ends either in a safe default or in a
decision card for the person. Tickets are native board cards, optionally
linked to a GitHub or Linear source; in phase 1 the tracker side is
exercised through fixtures only, with no live tracker writes. Runs are
durable: after a restart the runner knows which steps completed, which are
live and which are interrupted or unknown, and it pauses rather than
replaying anything with an unresolved effect. People see a plain view of
events and open cards, not a raw stream. A local coding fixture is one test
case; it grants no push, pull request or other outward action.

## Principles for phase 1

- Native, not a plugin. Flows need a shell, files, agent processes and
  supervision; they are built into Deck and reuse its board, cards and
  push notifications.
- Deterministic checks decide pass or fail. A step never passes on an
  agent's own written report.
- The runner checks results itself: declared outputs exist and its own
  verification step passes.
- Roles, not vendors. A flow names a role; local configuration binds the
  role to a runtime command the person trusts.
- People hold the cardinal acts. The host has no automatic merge, deploy,
  production, send or spend action. Gates are deliberate human acts.
- Honest limits. Host gates and process-group ownership do not confine an
  arbitrary shell or guarantee network silence. An agent command can do
  what its operating-system user can.

## Concepts

- Flow: a definition of steps with prompts. The definition format and
  where definitions are loaded from are open (see Decisions). Whatever is
  chosen, phase 1 needs strict validation (unknown keys refused), a cap on
  every loop, an immutable flow version recorded on each run, and explicit
  selection of the flow by the person.
- Ticket: a card on Deck's Projects board, optionally linked to an
  external source.
- Run: one execution of one flow version for one ticket, with durable step
  state, events and cards.
- Role: a named part in a flow, bound locally to a trusted runtime
  command.

## Step types in phase 1

| Type | What it does | Result |
|---|---|---|
| `agent` | A role does one bounded piece of judgement work in a working folder, through the runtime-neutral adapter | Exit code and a result file; outputs checked by the runner |
| `run` | A deterministic command from the trusted local configuration or the approved project definition | Exit code and a structured verification result |
| `decide` | Chooses among declared options; in phase 1 the only rung is a decision card, with a safe default (stop or escalate) | The person's choice or the safe default |
| `gate` | A decision card: approve, push back with a note, or stop | The person's answer |
| `action` | A host action from a fixed list: `claim`, `board-move`, `reconcile-source` (fixture adapters only) | Recorded outcome |

Composition in phase 1: a `loop` between the agent step and verification,
with a required maximum and a card when it is exhausted. No expressions;
any logic goes in a `run` step.

## The phase 1 flow

1. `claim` (action): claim the card for this flow, read the source through
   the adapter (fixtures in tests).
2. `work` (agent): one bounded step with a time limit.
3. `verify` (run): deterministic checks of the step's declared outputs.
   On failure, back to `work`, up to the loop maximum, then a card.
4. `outcome` (decide): a card for the person, or the safe default.
5. `reconcile-source` (action): end-only reconciliation with the source
   adapter, in phase 1 against fixtures only.

## Tickets, claims and the source

- The Projects board stays the internal board. Cards gain optional
  frontmatter keys for the source identity, the flow and the active run.
  Card edits are targeted line edits that leave the body and unknown keys
  unchanged.
- Source identity is unique per card: pulling the same source twice
  updates one card (an upsert on the source key), never two.
- The claim belongs to the card and its source, not to a run. A durable
  claim record allows one active runner per card; a second start for the
  same card is refused. On restart, the claim's owner is resolved from
  durable state before anything runs.
- Phase 1 tracker pull and reconciliation run against fixtures only. No
  live tracker state change, no comment writes, no credentials, no push,
  pull request or send.
- Reconciliation is designed for the later live case without claiming
  more than it can. Each intended external effect is recorded durably
  first, with a stable operation identity. Outcomes are recorded as done,
  conflict (the source changed in a way the flow does not expect) or
  unknown (the result of an attempt cannot be established). Conflict and
  unknown raise a card. Before any retry the runner reconciles the
  recorded intent against the source, or stops. Reading before writing,
  comment markers or a matching state cannot alone prove a remote effect
  happened once; a later live adapter needs provider-level deduplication
  or an equivalent explicit reconciliation.

## Runs, records and recovery

- A runner supervisor process sits beside the web server, like Deck's
  existing helper processes. Each step attempt has durable state: started,
  completed with a checked result, or interrupted or unknown.
- On restart the runner keeps completed steps completed. Before replaying
  a step it proves the prior attempt completed or settled. It adopts a
  step only when it proves that step is live and owned by this run;
  otherwise it pauses with a card. It never launches a step again while
  an old child process may still be live.
- Timeouts and cancel stop the supported fixture's process group. Cleanup
  is observed and reported; a failure to clean up is surfaced as an event
  and a card, not hidden. Deck does not promise that every descendant
  process ends or that every process failure leaves the web server
  unaffected.
- Records kept for resume: flow and version, step states, outcomes and the
  entries needed to recover. Raw logs, prompts, process data and private
  artefacts stay in Deck's local data folder, under private handling, and
  are never linked from public places.
- Nothing is committed or published automatically. A repository-visible
  run summary, if wanted, is built from allowlisted structured fields and
  needs a person's review and approval before export.
- Raw process output is treated as potentially sensitive. No claim is made
  that logs or records are free of secrets, or that redaction or a leak
  check proves an export safe.

## What people see

- Three kinds of thing, through Deck's existing card and push paths:
  decision cards (the run waits on the person), action cards (something to
  do; the run does not wait) and events (one plain line: what happened).
- A plain run view: the card's current step, the events, and any open
  cards. No raw stream as the default view. The UI iterates once the
  mechanism works.

## Safety and limits

| Area | Host behaviour in phase 1 | Not covered |
|---|---|---|
| Cardinal acts | No merge, deploy, production, send or spend action exists; no live tracker writes | An agent command run by its user can still attempt them |
| Access | Host allowlists for working folders and commands; trusted local runtime profiles; the project definition approved before use | Confinement of an arbitrary shell; network silence |
| Limits | Caps per step, per run, per loop and on concurrent runs; a pause path | Execution caps do not enforce a monetary cap on arbitrary agent or external calls |
| Credentials | Host-managed credentials stay in local configuration, outside flow definitions, commands, records and prompts | Anything an agent command reads on its own |
| Input trust | Ticket text and agent output are data, not instructions to the host | What an agent does with text it reads |
| Results | Pass or fail comes from the runner's own checks | The quality of an agent's prose |

## Testing (proposed)

- Schema: the phase 1 flow validates; unknown keys, a loop without a
  maximum, an unsafe default and an unknown action are refused.
- State: golden event logs to step states, including interrupted and
  unknown steps.
- A fake runtime (a script that writes results as told), so no test calls
  a model: an output the step claims but did not write is refused.
- Recovery: killing the runner mid-step and restarting resumes known
  states and pauses on an unresolved effect.
- Cancel and timeout on the supported fixture: the process group is gone,
  or the failure is reported.
- Board: two pulls of one source give one card; a second start on a
  claimed card is refused; edits leave body and unknown keys unchanged.
- Tracker fixtures for GitHub and Linear plus a fake tracker: replay after
  a simulated crash records no second effect; conflict and unknown
  outcomes raise cards; no test uses a live account.
- Credentials: a sentinel credential is absent from named runner-written
  fields (step records, event captions, card text and diagnostics).
- Local coding fixture: the agent step edits a temporary repository and
  `verify` runs its checks; the fixture exercises no push or PR.

## Acceptance outline (phase 1)

- A person can start the phase 1 flow from a card; the card is claimed and
  moves through its columns.
- A verification failure loops and stops at a card after the maximum.
- A step that reports an output it did not produce does not pass.
- After a runner restart, completed steps stay completed; a step is
  replayed only after its prior attempt is proved completed or settled,
  adopted only when proved live and owned, and otherwise paused with a
  card; no step is launched again while an old child may still be live.
- Fixture reconciliation records each intended effect once, and conflict
  and unknown outcomes surface as cards.
- Cancel on the supported fixture leaves no observed process, or reports
  that it could not.
- The sentinel credential is absent from the named runner-written fields.
- The run view shows events and open cards.

## Subtasks (proposed child issues of #155)

- [ ] 1a: Flow definition loading and validation, the phase 1 flow and the test-case flows (M)
- [ ] 1b: Runner supervisor, durable step state, recovery and the event and card records (M)
- [ ] 1c: Runtime-neutral command adapter: limits, timeout, cancel, result contract (M)
- [ ] 1d: Board claims and source identity; tracker adapter interface; GitHub and Linear adapters on fixtures; intent and reconciliation records (M)
- [ ] 1e: Local records and the plain run view of events and open cards (S to M)

## Decisions for the maintainer (phase 1)

Recommendations only; none is decided.

1. Definition format and loading. Proposed: restricted YAML with a
   published JSON Schema, loaded from Deck's built-in flows and from the
   project. Alternatives remain open. Whatever is chosen keeps strict
   validation, capped loops and a version pinned per run.
2. Interpreter. Proposed: Deck's own small runner rather than an external
   workflow library, because the step set is small and suspension is the
   card mechanism.
3. `decide` in phase 1 with the card rung and a safe default only.
4. Both GitHub and Linear adapters in phase 1, on fixtures only, because
   one adapter cannot prove the interface. Alternative: GitHub only.
5. Claims keyed to the card and its source, one active runner per card.
6. Run records local only; any repository-visible summary built from
   allowlisted fields and exported only after review.
7. Runs started by a person only; no automatic start.

## Origin

Maintainer direction, 18 November 2026, recorded in #155. Related
contributor conventions are in #39.

## Not in phase 1

- Live tracker writes, comments, push, pull requests, sends or any other
  outward action.
- Automatic starts or automatic flow selection.
- A raw log stream as the public or default view.
- Publication or commit of run records.

## Log

### 2026-11-18: phase 1 public SPEC
- What changed: this file now covers phase 1 only, after a privacy and
  wording review. The format and loading layers are proposals; tracker
  work is fixture-only; claims are per card and source; recovery, cancel
  and cleanup are scoped acceptance contracts; records stay local.
- Why: keep the public specification to the first slice and to claims the
  design can support.
- Supersedes: the earlier drafts of this file, which covered every phase.
- Commits: none yet.
