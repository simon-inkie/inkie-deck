/**
 * Public surface of the domain layer. Everything outside src/domain imports
 * from here; the boundary rules let adapters and UI depend on the domain and
 * never the other way round.
 */
export type {
  Action,
  ActionState,
  CapabilityState,
  Clock,
  Decision,
  DecisionOutcome,
  DecisionState,
  DeliveryState,
  IsoTimestamp,
  Message,
  MessagePayload,
  Participant,
  ParticipantAvailability,
  ParticipantId,
  ParticipantKind,
  Thread,
  TransitionRefusal,
  TransitionResult,
  Workspace,
} from "./types.ts";

export {
  appendToThread,
  completeAction,
  dismissAction,
  draftMessage,
  markMessageRead,
  markThreadRead,
  openAction,
  openDecision,
  openThread,
  resolveDecision,
  supersedeAction,
  unreadMessages,
  workspaceCapability,
} from "./transitions.ts";
