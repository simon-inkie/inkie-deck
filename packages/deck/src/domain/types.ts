/**
 * The neutral domain model: types only, no behaviour.
 *
 * This layer is a local control surface for a team of correspondents, not a
 * model of any particular team's setup. Three rules keep it that way, and the
 * dependency-cruiser config enforces the mechanical parts:
 *
 * 1. No privileged names. There is no built-in owner, no special participant
 *    and no hardcoded roster. Participants arrive from configuration or a
 *    provider. A participant name appearing as a literal anywhere in this
 *    layer is a bug.
 * 2. Time is injected. Nothing here reads a system clock; every transition
 *    that records a time takes a Clock. No real dates, working hours or
 *    service levels appear in defaults.
 * 3. This layer imports nothing but language primitives (and, if ever needed,
 *    the protocol types from inkie-agents-base). Adapters and UI depend on
 *    the domain; the domain never depends on them.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A timestamp as the protocol carries it: an opaque run of non-whitespace
 * characters, by convention ISO 8601 in UTC (protocol section 5). The domain
 * never interprets or compares these; ordering is positional (section 9.2).
 */
export type IsoTimestamp = string;

/**
 * The injected time source. The ONLY way domain code learns the current
 * moment. Production passes a real-clock implementation at the edge; tests
 * pass a fixed or scripted one.
 */
export interface Clock {
  now(): IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/**
 * A stable identifier for a correspondent. Opaque to the domain, as
 * participant names are opaque to the protocol (section 3).
 */
export type ParticipantId = string;

/**
 * What kind of correspondent this is. "agent" is a participant TYPE here,
 * deliberately not the universal noun: a thread between two humans is just as
 * valid as one between two automated participants.
 */
export type ParticipantKind = "human" | "agent";

/**
 * Whether the participant can currently be reached. "unavailable" is a
 * normal, supported state (a remote correspondent whose transport is down,
 * a human who is away), not an error.
 */
export type ParticipantAvailability = "available" | "unavailable";

/** A human or automated correspondent with display metadata. */
export interface Participant {
  readonly id: ParticipantId;
  readonly displayName: string;
  readonly kind: ParticipantKind;
  readonly availability: ParticipantAvailability;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * A capability as the domain sees it: explicitly configured, or absent.
 * Absence is a supported state that consumers degrade through, never an
 * error. The environment-resolution seam (src/capabilities.ts) maps into
 * this shape at the edge; the domain never reads an environment itself.
 */
export type CapabilityState =
  | { readonly status: "configured" }
  | { readonly status: "absent"; readonly reason: string };

/**
 * One configured local data boundary: the paths a store may operate inside
 * and the capability configuration that applies within it. Not a company and
 * not an organisation; one machine may hold several.
 *
 * `root` is an opaque configured location. It has no default: a workspace
 * cannot exist without one being chosen explicitly, which is what keeps any
 * adapter from quietly pointing itself at a real home directory.
 */
export interface Workspace {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly capabilities: Readonly<Record<string, CapabilityState>>;
}

// ---------------------------------------------------------------------------
// Messages and threads
// ---------------------------------------------------------------------------

/**
 * Delivery state expresses product truth, not mechanics: "read" means the
 * recipient has rendered the message (protocol section 6), never that some
 * text was written into a terminal. Exactly two values, matching the
 * protocol, and "read" is terminal.
 */
export type DeliveryState = "sent" | "read";

/** The immutable part of a message. Nothing here ever changes after send. */
export interface MessagePayload {
  readonly sender: ParticipantId;
  readonly subject: string;
  readonly body: string;
  readonly sentAt: IsoTimestamp;
}

/** An immutable payload plus its mutable delivery state. */
export interface Message {
  readonly payload: MessagePayload;
  readonly delivery: DeliveryState;
}

/**
 * The complete ordered exchange between exactly two participants (protocol
 * section 1). Order is positional and never re-derived from timestamps
 * (section 9.2). A message whose sender is neither participant is tolerated,
 * as the protocol tolerates it in a thread file: the domain reads what is
 * there, it does not repair it.
 */
export interface Thread {
  readonly participants: readonly [ParticipantId, ParticipantId];
  readonly messages: readonly Message[];
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** How an open decision was answered: one of the offered options, or prose. */
export type DecisionOutcome =
  | { readonly kind: "selected"; readonly option: string }
  | { readonly kind: "freeText"; readonly text: string };

export type DecisionState =
  | { readonly phase: "open" }
  | {
      readonly phase: "resolved";
      readonly outcome: DecisionOutcome;
      readonly resolvedBy: ParticipantId;
      readonly resolvedAt: IsoTimestamp;
    };

/**
 * A typed question awaiting a selected or free-text outcome. "resolved" is
 * terminal: a decision is answered once, and changing the answer is a new
 * decision, not a mutation of this one.
 */
export interface Decision {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly freeTextAllowed: boolean;
  readonly state: DecisionState;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionState =
  | { readonly phase: "open" }
  | {
      readonly phase: "completed";
      readonly by: ParticipantId;
      readonly at: IsoTimestamp;
    }
  | {
      readonly phase: "dismissed";
      readonly by: ParticipantId;
      readonly at: IsoTimestamp;
    }
  | {
      readonly phase: "superseded";
      readonly successor: string;
      readonly by: ParticipantId;
      readonly at: IsoTimestamp;
    };

/**
 * Work awaiting completion, dismissal or supersession. All three closed
 * phases are terminal, and they are distinct on purpose: "completed" claims
 * the work happened, "dismissed" claims it should not, "superseded" points
 * at the action that replaced it.
 */
export interface Action {
  readonly id: string;
  readonly title: string;
  readonly state: ActionState;
}

// ---------------------------------------------------------------------------
// Transition results
// ---------------------------------------------------------------------------

/**
 * Why a transition was refused. A closed union rather than prose so callers
 * branch on it; rendering these for a human is a UI concern.
 */
export type TransitionRefusal =
  | "message-already-read"
  | "recipient-is-sender"
  | "decision-already-resolved"
  | "option-not-offered"
  | "free-text-not-allowed"
  | "empty-free-text"
  | "action-not-open"
  | "action-cannot-supersede-itself";

/**
 * The outcome of every transition. Refusals are values, not exceptions:
 * an illegal transition is an expected answer to a question ("may this
 * happen?"), not a programming error.
 */
export type TransitionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TransitionRefusal };
