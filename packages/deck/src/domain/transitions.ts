/**
 * Pure state transitions over the domain types.
 *
 * Every function here is total and side-effect free: it takes values, returns
 * new values, and never mutates its inputs. Time only ever arrives through an
 * injected Clock. Refusals are returned, not thrown.
 */
import type {
  Action,
  Clock,
  Decision,
  DecisionOutcome,
  Message,
  MessagePayload,
  ParticipantId,
  Thread,
  TransitionRefusal,
  TransitionResult,
  Workspace,
  CapabilityState,
} from "./types.ts";

function ok<T>(value: T): TransitionResult<T> {
  return { ok: true, value };
}

function refuse<T>(refusal: TransitionRefusal): TransitionResult<T> {
  return { ok: false, refusal };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Create a new outbound message. Always born with delivery "sent" (protocol
 * section 6: a writer MUST create a message with status sent), stamped from
 * the injected clock.
 */
export function draftMessage(
  clock: Clock,
  draft: { sender: ParticipantId; subject: string; body: string },
): Message {
  return {
    payload: {
      sender: draft.sender,
      subject: draft.subject,
      body: draft.body,
      sentAt: clock.now(),
    },
    delivery: "sent",
  };
}

/**
 * The recipient renders the message: sent becomes read. The two protocol
 * rules (section 6) are both here: read is terminal, and a participant never
 * transitions its own outbound messages.
 */
export function markMessageRead(
  message: Message,
  onBehalfOf: ParticipantId,
): TransitionResult<Message> {
  if (onBehalfOf === message.payload.sender) {
    return refuse("recipient-is-sender");
  }
  if (message.delivery === "read") {
    return refuse("message-already-read");
  }
  return ok({ ...message, delivery: "read" });
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** An empty exchange between two participants. */
export function openThread(a: ParticipantId, b: ParticipantId): Thread {
  return { participants: [a, b], messages: [] };
}

/**
 * Append a message. Position is the only ordering (protocol section 9.2):
 * the message goes at the end whatever its timestamp says, and nothing is
 * ever reordered or repaired. Senders outside the participant pair are
 * tolerated, exactly as a reader must tolerate them in a thread file.
 */
export function appendToThread(thread: Thread, message: Message): Thread {
  return { ...thread, messages: [...thread.messages, message] };
}

/**
 * Mark every message the recipient has not yet rendered as read. Messages
 * the recipient sent, and messages already read, pass through untouched.
 * Returns the new thread and how many messages actually changed.
 */
export function markThreadRead(
  thread: Thread,
  onBehalfOf: ParticipantId,
): { thread: Thread; changed: number } {
  let changed = 0;
  const messages = thread.messages.map((message) => {
    const result = markMessageRead(message, onBehalfOf);
    if (result.ok) {
      changed += 1;
      return result.value;
    }
    return message;
  });
  return { thread: { ...thread, messages }, changed };
}

/** The messages a recipient has not yet rendered. */
export function unreadMessages(
  thread: Thread,
  recipient: ParticipantId,
): readonly Message[] {
  return thread.messages.filter(
    (m) => m.delivery === "sent" && m.payload.sender !== recipient,
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** A new decision, open, awaiting its outcome. */
export function openDecision(spec: {
  id: string;
  question: string;
  options: readonly string[];
  freeTextAllowed: boolean;
}): Decision {
  return {
    id: spec.id,
    question: spec.question,
    options: [...spec.options],
    freeTextAllowed: spec.freeTextAllowed,
    state: { phase: "open" },
  };
}

/**
 * Answer an open decision. A selected outcome must name one of the offered
 * options; a free-text outcome must be allowed and non-empty. Resolution is
 * terminal: answering an answered decision is refused, whoever asks.
 */
export function resolveDecision(
  decision: Decision,
  outcome: DecisionOutcome,
  resolvedBy: ParticipantId,
  clock: Clock,
): TransitionResult<Decision> {
  if (decision.state.phase !== "open") {
    return refuse("decision-already-resolved");
  }
  if (outcome.kind === "selected" && !decision.options.includes(outcome.option)) {
    return refuse("option-not-offered");
  }
  if (outcome.kind === "freeText") {
    if (!decision.freeTextAllowed) {
      return refuse("free-text-not-allowed");
    }
    if (outcome.text.trim() === "") {
      return refuse("empty-free-text");
    }
  }
  return ok({
    ...decision,
    state: { phase: "resolved", outcome, resolvedBy, resolvedAt: clock.now() },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** A new piece of work, open, awaiting completion, dismissal or supersession. */
export function openAction(spec: { id: string; title: string }): Action {
  return { id: spec.id, title: spec.title, state: { phase: "open" } };
}

function closeAction(
  action: Action,
  state: Action["state"],
): TransitionResult<Action> {
  if (action.state.phase !== "open") {
    return refuse("action-not-open");
  }
  return ok({ ...action, state });
}

/** The work happened. Terminal. */
export function completeAction(
  action: Action,
  by: ParticipantId,
  clock: Clock,
): TransitionResult<Action> {
  return closeAction(action, { phase: "completed", by, at: clock.now() });
}

/** The work should not happen. Terminal. */
export function dismissAction(
  action: Action,
  by: ParticipantId,
  clock: Clock,
): TransitionResult<Action> {
  return closeAction(action, { phase: "dismissed", by, at: clock.now() });
}

/** Another action replaced this one. Terminal, and never self-referential. */
export function supersedeAction(
  action: Action,
  successor: string,
  by: ParticipantId,
  clock: Clock,
): TransitionResult<Action> {
  if (successor === action.id) {
    return refuse("action-cannot-supersede-itself");
  }
  return closeAction(action, { phase: "superseded", successor, by, at: clock.now() });
}

// ---------------------------------------------------------------------------
// Workspace capabilities
// ---------------------------------------------------------------------------

/**
 * Look a capability up on a workspace. A name the configuration never
 * mentions is absent, because absence is the default supported state, not a
 * missing key error.
 */
export function workspaceCapability(
  workspace: Workspace,
  name: string,
): CapabilityState {
  return (
    workspace.capabilities[name] ?? {
      status: "absent",
      reason: `capability "${name}" is not configured for this workspace`,
    }
  );
}
