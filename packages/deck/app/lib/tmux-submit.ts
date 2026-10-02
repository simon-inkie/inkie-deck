/**
 * Reusable verified-submit policy for tmux-backed agent panes.
 *
 * This module knows nothing about fleet names, tmux sessions, inbox storage or
 * deployment paths. Its caller supplies classified pane snapshots and bounded
 * side effects through PaneSubmitDriver.
 */

export type PaneSnapshot = {
  activity: "idle" | "active";
  composer: "clean" | "ghost" | "staged" | "unknown";
  stagedText?: string;
  stagedRows?: readonly {
    text: string;
    rightPadded: boolean;
  }[];
};

export type SendKeysResult =
  | {
      status: "submitted";
      evidence: "turn-started" | "composer-cleared";
      enterAttempts: number;
    }
  | {
      status: "not-submitted";
      reason:
        | "invalid-window"
        | "empty-text"
        | "text-too-long"
        | "window-not-live"
        | "text-send-failed"
        | "enter-failed"
        | "retry-exhausted"
        | "unexpected-error";
      error: string;
      enterAttempts: number;
    }
  | {
      status: "not-attempted";
      reason:
        | "unsafe-composer"
        | "verification-unavailable"
        | "busy-queue-pending"
        | "composer-changed";
      error: string;
      enterAttempts: number;
    };

export interface PaneSubmitDriver {
  capture(): PaneSnapshot | undefined;
  sendText(text: string): boolean;
  pressEnter(): boolean;
  wait(ms: number): Promise<void>;
}

export type PaneSubmitTiming = {
  enterDelayMs: number;
  verifyDelaysMs: readonly number[];
};

/**
 * Positive identity check for the one allowed Enter retry. Display rows retain
 * every visible payload byte after the adapter removes only TUI framing. At an
 * app-drawn row boundary, consume exactly one separator already present in the
 * original payload; never collapse or rewrite arbitrary whitespace. Hidden
 * paste placeholders cannot match and therefore fail closed.
 */
export function composerHoldsPayload(
  stagedText: string,
  payload: string,
  stagedRows?: PaneSnapshot["stagedRows"]
): boolean {
  if (stagedRows === undefined) return stagedText === payload;

  let offset = 0;
  for (let index = 0; index < stagedRows.length; index++) {
    const row = stagedRows[index];
    if (row === undefined || !payload.startsWith(row.text, offset)) return false;
    offset += row.text.length;
    if (index === stagedRows.length - 1) continue;

    // Claude omits one exact payload separator at an app-drawn row boundary:
    // a space for word wrap or a newline for explicit multiline input. A full
    // row can also split a long token without consuming any payload byte.
    const separator = payload[offset];
    if (separator === " " || separator === "\n") {
      offset += 1;
    } else if (row.rightPadded) {
      return false;
    }
  }
  return offset === payload.length;
}

type VerificationState =
  | { kind: "confirmed"; evidence: "turn-started" | "composer-cleared" }
  | { kind: "owned-idle" }
  | { kind: "owned-busy" }
  | { kind: "unavailable" }
  | { kind: "changed" };

function evaluatePostEnter(
  snapshot: PaneSnapshot | undefined,
  payload: string,
  baselineWasActive: boolean
): VerificationState {
  if (snapshot === undefined) {
    return { kind: "unavailable" };
  }
  if (snapshot.composer === "clean" || snapshot.composer === "ghost") {
    return { kind: "confirmed", evidence: "composer-cleared" };
  }
  // Staged content is evaluated before activity. A payload may itself contain
  // strings such as "(45s" or "esc to interrupt" and must not prove its own
  // submission by tripping a broad activity marker.
  if (snapshot.composer === "staged") {
    if (
      !composerHoldsPayload(
        snapshot.stagedText ?? "",
        payload,
        snapshot.stagedRows
      )
    ) {
      return { kind: "changed" };
    }
    return snapshot.activity === "active"
      ? { kind: "owned-busy" }
      : { kind: "owned-idle" };
  }
  if (!baselineWasActive && snapshot.activity === "active") {
    return { kind: "confirmed", evidence: "turn-started" };
  }
  return { kind: "unavailable" };
}

async function pollPostEnter(
  driver: PaneSubmitDriver,
  timing: PaneSubmitTiming,
  payload: string,
  baselineWasActive: boolean
): Promise<VerificationState> {
  let state: VerificationState = { kind: "unavailable" };
  for (const delay of timing.verifyDelaysMs) {
    await driver.wait(delay);
    state = evaluatePostEnter(driver.capture(), payload, baselineWasActive);
    if (state.kind !== "owned-idle") return state;
  }
  return state;
}

function unconfirmedResult(
  state: Exclude<VerificationState, { kind: "confirmed" } | { kind: "owned-idle" }>,
  enterAttempts: number,
  error: string
): SendKeysResult {
  const reason =
    state.kind === "unavailable"
      ? "verification-unavailable"
      : state.kind === "owned-busy"
        ? "busy-queue-pending"
        : "composer-changed";
  return { status: "not-attempted", reason, error, enterAttempts };
}

/** Run one text send, one Enter and at most one positively-safe Enter retry. */
export async function submitPaneText(
  payload: string,
  driver: PaneSubmitDriver,
  timing: PaneSubmitTiming
): Promise<SendKeysResult> {
  const baseline = driver.capture();
  if (
    baseline === undefined ||
    (baseline.composer !== "clean" && baseline.composer !== "ghost")
  ) {
    return {
      status: "not-attempted",
      reason: "unsafe-composer",
      error: "The target composer is not proven safe.",
      enterAttempts: 0,
    };
  }
  const baselineWasActive = baseline.activity === "active";

  if (!driver.sendText(payload)) {
    return {
      status: "not-submitted",
      reason: "text-send-failed",
      error: "Could not send text to the window.",
      enterAttempts: 0,
    };
  }
  await driver.wait(timing.enterDelayMs);
  if (!driver.pressEnter()) {
    return {
      status: "not-submitted",
      reason: "enter-failed",
      error: "Text sent but submit (Enter) failed.",
      enterAttempts: 1,
    };
  }

  let state = await pollPostEnter(driver, timing, payload, baselineWasActive);
  if (state.kind === "confirmed") {
    return { status: "submitted", evidence: state.evidence, enterAttempts: 1 };
  }
  if (state.kind !== "owned-idle") {
    return unconfirmedResult(state, 1, "Text sent, but submission could not be verified.");
  }

  // A final capture closes the delayed-submit race immediately before retry.
  state = evaluatePostEnter(driver.capture(), payload, baselineWasActive);
  if (state.kind === "confirmed") {
    return { status: "submitted", evidence: state.evidence, enterAttempts: 1 };
  }
  if (state.kind !== "owned-idle") {
    return unconfirmedResult(state, 1, "Text sent, but a safe retry could not be proven.");
  }

  if (!driver.pressEnter()) {
    return {
      status: "not-submitted",
      reason: "enter-failed",
      error: "Text sent, but the retry Enter failed.",
      enterAttempts: 2,
    };
  }
  state = await pollPostEnter(driver, timing, payload, baselineWasActive);
  if (state.kind === "confirmed") {
    return { status: "submitted", evidence: state.evidence, enterAttempts: 2 };
  }
  if (state.kind === "owned-idle") {
    return {
      status: "not-submitted",
      reason: "retry-exhausted",
      error: "Text remains in the composer after the safe Enter retry.",
      enterAttempts: 2,
    };
  }
  return unconfirmedResult(
    state,
    2,
    "Submission remains unverified after the safe Enter retry."
  );
}
