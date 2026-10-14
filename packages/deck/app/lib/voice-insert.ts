/**
 * voice-insert.ts - Pure helpers for the voice transcript pipeline.
 *
 * computeVoiceInsert: the insertion maths for FINAL transcript results,
 * extracted from Compose.tsx's handleFinalText so the additive-insert
 * contract is unit-testable with plain final-sequences (no DOM, no hook).
 *
 * isSpeechSignal: classifies a parsed proxy message as speech evidence
 * (interim/final transcript) vs machinery (status, dg_raw, anything else).
 * The 10s silence auto-stop timer resets ONLY on speech signals.
 *
 * SILENCE_AUTO_STOP_MS: the auto-stop window. Exported so tests pin the
 * value and a future tune is a one-line change.
 *
 * Pure module: no env, no fs, no DOM.
 * ASCII only - no em-dashes.
 */

/**
 * Auto-stop after this many ms without a speech signal.
 * Raised from 10s to 30s. The timer only re-arms on a speech signal
 * (interim/final), not on audio, so a thinking pause during dictation never
 * re-armed it and the mic cut off mid-thought at 10s. 30s of TOTAL silence is
 * genuinely "done/forgot" while a normal pause never trips it. Cost is
 * negligible (Deepgram bills audio duration; the extra grace is only spent on a
 * pause that actually times out). A future KeepAlive-during-silence pass would
 * make pauses free and let this go higher cheaply.
 */
export const SILENCE_AUTO_STOP_MS = 30_000;

export interface VoiceInsertResult {
  /** The full new textarea value after the insert. */
  newValue: string;
  /** The advanced anchor: position directly after the inserted text. */
  newAnchor: number;
}

/**
 * Compute the additive insertion of a FINAL transcript at the voice anchor.
 *
 * Contract:
 * - The anchor is clamped to the CURRENT value length - purely protective
 *   (user deleted text before the anchor); against fresh text it never
 *   shrinks a correctly-advanced anchor.
 * - A single space separator is added when the text before the anchor does
 *   not already end in whitespace.
 * - The returned newAnchor sits directly after the inserted text, so the
 *   next final lands behind this one regardless of the live cursor.
 * - Text after the anchor (typed mid-session) is preserved, shifted right.
 *
 * @param currentValue - The LATEST full textarea value (never a stale render capture).
 * @param anchor - The current voice anchor position.
 * @param text - The final transcript text to insert.
 */
export function computeVoiceInsert(
  currentValue: string,
  anchor: number,
  text: string
): VoiceInsertResult {
  const clamped = Math.max(0, Math.min(anchor, currentValue.length));

  const before = currentValue.slice(0, clamped);
  const after = currentValue.slice(clamped);
  const separator =
    before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n")
      ? " "
      : "";

  const newValue = before + separator + text + after;
  const newAnchor = clamped + separator.length + text.length;

  return { newValue, newAnchor };
}

/**
 * True when a parsed proxy message is evidence of speech: an interim or
 * final transcript with text. Status frames, dg_raw mirrors, and unknown
 * shapes are machinery - they must NOT reset the silence auto-stop timer.
 */
export function isSpeechSignal(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    (m["type"] === "interim" || m["type"] === "final") &&
    typeof m["text"] === "string"
  );
}
