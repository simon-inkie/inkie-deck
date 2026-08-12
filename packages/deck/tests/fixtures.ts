/**
 * The fixture world for the deck test suites. Everything here is invented
 * and written fresh for these tests: no participant, place, timestamp or
 * message is an anonymised copy of any real conversation.
 *
 * The cast is small, stable and deliberately non-isomorphic to any real
 * team, so it cannot mirror one:
 *
 *   - odile: a human, restoring a canal boat and coordinating the work
 *   - quill: an automated participant, odile's note-keeping agent
 *   - pharos: a remote participant at the boatyard's far mooring whose
 *     link is down; unavailable is a normal state, not an error
 *
 * Every test builds its content from these builders rather than storing
 * transcript files, so fixture review stays finite.
 */
import type {
  Clock,
  Message,
  Participant,
} from "../src/domain/index.ts";

export const odile: Participant = {
  id: "odile",
  displayName: "Odile",
  kind: "human",
  availability: "available",
};

export const quill: Participant = {
  id: "quill",
  displayName: "Quill",
  kind: "agent",
  availability: "available",
};

export const pharos: Participant = {
  id: "pharos",
  displayName: "Pharos",
  kind: "agent",
  availability: "unavailable",
};

export const cast: readonly Participant[] = [odile, quill, pharos];

/** A fictional instant, well clear of any real project's calendar. */
export const EPOCH = "2031-03-07T09:00:00Z";

/** A clock frozen at one instant. */
export function fixedClock(at: string = EPOCH): Clock {
  return { now: () => at };
}

/**
 * A clock that yields each timestamp in turn and then holds the last one.
 * For tests that need distinguishable instants without real time.
 */
export function sequenceClock(timestamps: readonly string[]): Clock {
  let index = 0;
  return {
    now: () => {
      const at = timestamps[Math.min(index, timestamps.length - 1)]!;
      index += 1;
      return at;
    },
  };
}

/** A message with sensible fixture defaults, overridable per field. */
export function makeMessage(overrides: {
  sender?: string;
  subject?: string;
  body?: string;
  sentAt?: string;
  delivery?: "sent" | "read";
} = {}): Message {
  return {
    payload: {
      sender: overrides.sender ?? quill.id,
      subject: overrides.subject ?? "mooring survey",
      body: overrides.body ?? "The hull notes from this morning are filed.",
      sentAt: overrides.sentAt ?? EPOCH,
    },
    delivery: overrides.delivery ?? "sent",
  };
}
