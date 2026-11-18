# #154: Add Agent Client Protocol support for agent sessions and events

- Issue: https://github.com/simon-inkie/inkie-deck/issues/154
- Branch: docs/node-pty-acp-spec (planning only; the build branch will be
  `154-<slug>`)
- Started: 2026-11-18
- Scope of this SPEC: the first slice only. Later work is planned outside
  this file and gets its own issues when it is ready.
- Companion: #153 (node-pty runner, `.specs/153-tmux-to-node-pty/`).
  Related: #155 (structured task flows).
- ISSUE-TEXT.md in this folder is a copy of the published issue body.
- No runtime is declared compatible by this SPEC.

## TL;DR

The Agent Client Protocol (ACP) is an open JSON-RPC protocol, carried over
a child process's stdin and stdout, for driving coding agents. It is not
MCP and not a terminal. This first slice pins one protocol version and one
client library, implements one adapter, and proves the client against a
scripted fixture agent: capability negotiation and refusal, ordered
events, cancellation, disconnect, strict turn settlement, and rejection of
wrong, duplicate, malformed or oversized messages. It also defines, once,
the shared event envelope (decision, action, happened) that #153 and #155
may use, with a bounded, typed display projection. The slice has no
production route or UI: everything runs in the test harness.

## What ACP is, and is not

Inputs from the protocol documentation, to be validated against the pinned
version and schema before relying on them:
- A client sends `initialize` and receives the agent's capabilities.
- `session/new` creates a session; `session/load` loads one only if the
  agent advertises that capability.
- `session/prompt` is a request; the agent streams `session/update`
  notifications (message chunks, tool calls upserted by id, plans) and the
  turn settles with a stop reason.
- The agent may send `session/request_permission` with named options; the
  client answers with one option or `cancelled`.
- `session/cancel` asks the agent to stop the current turn.
- A version 2 draft changes how a turn settles. It is not used here.

ACP is not the agent's own terminal interface: there is nothing to attach
to, and built-in commands exist only if the agent advertises them. It is
not MCP, which connects tools to agents. An adapter that wraps a vendor's
SDK is a different program from that vendor's CLI; its behaviour, sign-in
and terms must be checked for the chosen version, and this SPEC makes no
claim either way.

## Scope

In this slice:
- A pinned protocol version and a pinned client library (the protocol's
  official TypeScript library if it passes the licence gate).
- A client: process ownership, `initialize`, `session/new`, prompt,
  ordered updates, permission requests, cancel, settlement, disconnect.
- One adapter manifest for one candidate agent, selected when the version
  is pinned, recorded with its version.
- The shared event envelope and its typed display projection.
- Private records: a raw protocol record and a display journal, with
  ownership, confinement and retention rules.
- A scripted fixture agent and the tests below.

Not in this slice:
- Any production route, page, card written to a real thread, or push
  notification.
- `session/load` and resume, sub-agent views, more adapters, and use by
  #153 or #155.
- Advertising file system or terminal client capabilities.

## Independence

This slice needs nothing from #153 or #155. It runs its session processes
under its own small owner. #153 and #155 may adopt the envelope defined
here; neither must wait for this slice to land, and whichever needs the
envelope first lands it as a shared module from this definition.

## The client

### Capabilities

- `initialize` first; the advertised capabilities are stored per session.
- A method the agent did not advertise is never called. A caller that
  requires one gets a typed `unsupported` result.
- Deck advertises no file system and no terminal client capability.

### Session states

From a pure reducer over validated messages and process lifecycle:
`starting`, `idle`, `busy` (one prompt in flight), `waiting` (a permission
request open), `settled` (with an outcome, below), `failed`,
`disconnected`, `unsupported`.

- One prompt in flight per session. A second prompt is held by Deck until
  the first settles.
- A lost connection or exited process is detected by the client. An open
  turn at that moment ends `disconnected`, never settled, and nothing is
  re-sent automatically.
- Cancel: send `session/cancel`, answer an open permission request with
  `cancelled`, then wait a bounded time for settlement; past it, stop the
  process group and end `disconnected`.

### Settlement

Two different endings, kept apart:
- Valid settlement: the response to the turn's own `session/prompt`
  arrives and validates against the pinned response schema, including a
  stop reason in the pinned set. Only this gives `completed`, `truncated`,
  `refused`, `cancelled` or `failed`.
- Invalid termination: the matched response validates except that its
  stop reason is missing or not in the pinned set. This ends the turn
  `invalid` and is never a success.

The expected stop reasons for the pinned stable version, to be confirmed
at pinning, are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`
and `cancelled`.

| Input | Outcome | Counts as done |
|---|---|---|
| `end_turn` | `completed` | Yes. The only successful outcome |
| `max_tokens`, `max_turn_requests` | `truncated` | No |
| `refusal` | `refused` | No |
| `cancelled` | `cancelled` | No |
| A JSON-RPC error response to the prompt | `failed` | No |
| An `error` reason, if and only if the pinned schema defines one | `failed` | No |
| Any other reason, including custom ones, or a missing reason | `invalid`, recorded as a protocol violation | No |

Order of checks for a prompt response:
1. Framing: the line is within the size limit and parses as JSON.
2. Envelope and correlation: it is a well-formed JSON-RPC response whose
   id matches the prompt in flight for this session and generation.
   Anything failing 1 or 2 falls through to the general rules below.
3. Schema: the matched response is validated against the pinned response
   schema, with the stop reason checked last.
   - Valid, with a stop reason in the pinned set: valid settlement, by the
     table above.
   - Valid except for a missing or unknown stop reason: invalid
     termination. The turn ends `invalid`, the violation is recorded and
     the in-flight slot is released. This is the only case in which a
     response that fails the schema ends a turn.
   - Any other schema failure, including a malformed response that
     appears to carry `end_turn`: recorded as a violation and not
     accepted. It is never `completed`; the turn stays `busy` until a
     valid response, a cancel, a disconnect or the violation limit.

### Message validation

Every inbound message is checked before it reaches the reducer:
- Framing: one JSON value per line; a line over the size limit (default
  1 MiB, configurable) is discarded without parsing and recorded. Invalid
  JSON or a schema mismatch is recorded and discarded. A discarded message
  counts towards the violation limit but never settles or ends a turn on
  its own; only the matched prompt response above, a disconnect, cancel
  or the violation limit ends a turn.
- Identity: a response must match an outstanding request id; a
  notification must carry the session id of a live session in this
  client, and belong to the current generation (bumped on every restart of
  the process). Anything else is rejected and recorded.
- Duplicates: a second settlement for a request already settled is
  rejected; the first stands. A permission request id already answered is
  rejected.
- Repeated violations (default 5 in one session) end the session
  `failed` and stop its process group.
- Tool-call updates are upserts by tool call id within the session; an id
  from another session is rejected.

## The shared event envelope

Defined once, here. Used by this slice; available to #153 and #155.

```ts
type DeckEvent = {
  v: 1;
  id: string;                  // unique; used for dedupe
  seq: number;                 // per-source order
  ts: string;                  // ISO 8601
  source: {
    kind: "agent" | "subagent" | "session" | "run" | "stage";
    session?: string;
    generation?: number;
    parent?: string;           // parent session, run or task id
    task?: string;             // ticket, run or flow task id
  };
  class: "decision" | "action" | "happened";
  type: string;                // from a fixed list, e.g. permission.requested
  title: string;               // plain text, at most 200 characters
  view: DisplayProjection;     // typed and bounded, below
  dedupeKey?: string;
  answers?: string;            // id of the event this resolves
};
```

- `decision`: a person must choose (a permission request).
- `action`: a person should do something (a failed, truncated, refused,
  invalid or disconnected turn; an unsupported capability).
- `happened`: a fact (a tool call's latest state, a settled turn).

### Display projection

No adapter-specific or raw value reaches the display. `view` is a
discriminated union with bounded fields, filled by the adapter from
validated input only:

```ts
type DisplayProjection =
  | { kind: "tool"; name: string; toolKind: ToolKind; status: ToolStatus;
      paths: string[] }                       // at most 20, each at most 512 chars
  | { kind: "permission"; tool: string;
      options: { id: string; label: string; optionKind: OptionKind }[] }  // at most 6, labels at most 80 chars
  | { kind: "turn"; outcome: Outcome; reason: string }   // reason at most 64 chars
  | { kind: "text"; excerpt: string };                   // at most 500 chars
```

- `ToolKind`, `ToolStatus`, `OptionKind` and `Outcome` are closed enums;
  unknown values map to `other` or `invalid`.
- Every string has a bound, including identifiers:
  - Display text: `title` 200, tool `name` and permission `tool` 120,
    option `label` 80, `reason` 64, each path 512, `excerpt` 500
    characters. Display text over its bound is truncated.
  - Host-issued identifiers: the envelope `id`, `answers`, `dedupeKey` and
    every permission option `id` are issued by Deck, at most 64 printable
    ASCII characters. They are never copied from agent input.
  - Agent-supplied identifiers (session id in `source`, tool call ids, the
    agent's permission option ids): at most 128 printable ASCII
    characters. An identifier over that bound, or with other characters,
    is refused as a protocol violation, never truncated, because a
    truncated identifier can collide with or select a different one.
- Permission options: Deck gives each option a host-issued `id` and keeps
  a private map from it to the agent's own option id. An answer is sent
  only through that map, so a selection is always the exact option the
  agent offered. A permission request with more than 6 options, duplicate
  or refused option ids is not shown; it is answered `cancelled` and
  recorded as a violation. Deck never drops some options and shows the
  rest. This automatic `cancelled` is a fail-closed refusal: it never
  grants permission and never selects an option. Choosing a valid option
  is a consent decision, made only by the test harness in this slice.
- All strings are plain text, with control characters removed. Any later
  renderer must render them as text, never as markup.
- Tool inputs and outputs, reasoning content and message bodies beyond the
  excerpt never enter the envelope.

## Private records

- Two records per session, kept apart: a raw protocol record (every
  validated or rejected frame, for debugging) and a display journal (only
  `DeckEvent`s).
- Created and owned by Deck under the data root in a directory per
  session, named from a validated session id and generation, never from
  agent-supplied text. Paths are resolved and confined with the existing
  safe-fs rules. Directory mode 0700, files 0600; mode bits are a
  baseline, not a full confidentiality guarantee.
- Never served: no static file route, no download route, no route of any
  kind in this slice.
- Retention: the raw record is capped per session (default 10 MiB, oldest
  data dropped first) and deleted after a set age (default 14 days); the
  display journal is kept with the session and deleted with it.

## Security

- An ACP agent runs with the user's own permissions and its own tools.
  Not advertising client capabilities is not a sandbox, and this slice
  adds none.
- The child environment is an explicit allowlist plus what the adapter
  manifest names. Deck's own secrets are never passed.
- Each session runs in its own process group (a job object on Windows,
  later), so cancel and stop can end it fully. This is a requirement to
  prove in tests.
- Deck never grants a permission or selects an option on its own. In
  this slice, only the test harness chooses an option for a valid request.
  The one automatic reply is fail-closed: a request refused as invalid
  (see Permission options) is answered `cancelled`, which grants nothing.
- No production route or UI exists, so no access boundary is claimed. A
  later issue that exposes sessions in Deck must bring its own access
  protection; this slice does not rely on another issue's.

## The fixture agent

A scripted program that speaks the pinned version, driven by a script per
test: it advertises chosen capabilities, streams updates in a given order,
asks for permission, ignores or honours cancel, settles with any reason
(valid, invalid or missing), sends wrong ids, duplicates, invalid JSON and
oversized lines, and exits mid-turn. It runs in CI.

The chosen real candidate is run by hand in a scratch home as a recorded
conformance note for that version and platform only.

## Testing

Covers the core behaviour and the dangerous risks (a false success, a
repeated or lost prompt, an unattended permission, unbounded display
content), not every edge case.

- Capability refusal: an unadvertised method is never called, and the
  caller gets `unsupported`.
- Ordering: interleaved updates keep arrival order; tool-call patches give
  the latest state.
- Settlement: each row of the settlement table, including an unknown
  reason, a missing reason and a JSON-RPC error; only `end_turn` is
  `completed`. A matched prompt response with an unknown or missing reason
  settles `invalid` and releases the in-flight slot, so a following prompt
  is sent.
- Malformed apparent success: a matched response carrying `end_turn` but
  failing the pinned response schema is recorded as a violation and never
  becomes `completed`; the turn stays `busy` until cancel, disconnect or
  the violation limit.
- Unrelated malformed frames during a turn (invalid JSON, schema mismatch,
  a response to no outstanding request) are discarded and counted, and the
  turn stays `busy` until its own response arrives.
- Identity: wrong request id, wrong session id and stale generation are
  rejected and recorded.
- Duplicates: a second settlement and a second permission answer are
  rejected.
- Malformed and oversized: invalid JSON and over-limit lines are discarded
  and recorded; repeated violations end the session `failed`.
- Cancellation: with and without an open permission request, and with an
  agent that ignores cancel (ends `disconnected`, no process left).
- Disconnect: exit mid-turn and stdout closed mid-line end `disconnected`,
  and nothing is re-sent.
- A second prompt is held until the first settles.
- Projection: oversized and control-character input is bounded and
  stripped in every display field, including tool names and the
  permission tool name; no raw tool input or output appears in any
  envelope.
- Identifiers: envelope and permission option ids are host-issued and
  bounded; an over-long or invalid agent session, tool call or option id is
  refused, not truncated; two agent option ids that share a long prefix map
  to different host ids, and answering each selects exactly that option; a
  request with more than 6 options or duplicate ids is answered
  `cancelled` and not shown.
- Permission consent: an invalid request's automatic `cancelled` grants
  nothing and selects no option; a valid request is never answered until
  the harness chooses, and a request left unanswered keeps the turn
  `waiting`.
- Records: paths stay under the session directory; modes are set; no
  route serves them.

## Acceptance

- All tests above pass against the fixture in CI on Linux; other platforms
  are reported separately with their own evidence.
- Only `end_turn` produces a successful outcome; every other input,
  including unknown, ends in a non-success outcome. A matched response
  with an unknown or missing reason ends its turn `invalid`; a matched
  response that is otherwise malformed, even one that appears to carry
  `end_turn`, is never a success. Each unrelated malformed frame, on its
  own, never ends a turn; such frames still count towards the session's
  violation limit.
- Every projected string and identifier is bounded; a permission answer
  always selects the exact option the agent offered.
- With no ACP agent installed, Deck runs unchanged; no production route,
  page or notification is added.
- The envelope and display projection are defined here and implemented as
  a shared module.

## Decisions for the maintainer

Recommendations only.

1. Fixture-only first slice with no UI. Recommendation: yes; a session
   view comes with its own access protection in a later issue.
2. First candidate: an agent with native ACP support rather than an
   adapter over a vendor SDK, so the first proof tests the protocol.
   Recommendation: yes, chosen when the version is pinned.
3. Pin the stable version; do not use the version 2 draft yet.
   Recommendation: yes.
4. Only `end_turn` is success. Recommendation: yes.

## Log

### 2026-11-18: SPEC drafted
- What changed: wrote this SPEC and ISSUE-TEXT.md. A first draft covered
  later phases (cards in threads, sub-agent views, more adapters, resume);
  after a privacy and scope review the same day it was cut to the first
  slice, with strict settlement, message validation, a typed display
  projection and private record rules added.
- Why: maintainer direction; the envelope is shared with #153 and #155.
- Supersedes: nothing in this repository.
- Commits: none yet.
