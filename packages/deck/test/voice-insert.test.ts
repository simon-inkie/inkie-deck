/**
 * voice-insert.test.ts - Pins the additive-insert contract (TASK-446).
 *
 * THE bug being pinned: Alex's live session 2026-06-07 - "text in the input
 * box should be additive, right now it overwrites when i start speaking after
 * a pause." Root cause was a stale closure rebuilding the textarea from text
 * frozen at voice-session start. These tests drive computeVoiceInsert with
 * final-sequences against EVOLVING text, exactly as the fixed handleFinalText
 * does via its synchronous currentTextRef mirror.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect } from "vitest";
import {
  computeVoiceInsert,
  isSpeechSignal,
  SILENCE_AUTO_STOP_MS,
} from "../app/lib/voice-insert";

// ---------------------------------------------------------------------------
// computeVoiceInsert - the additive contract
// ---------------------------------------------------------------------------

describe("computeVoiceInsert - additive final sequences (the TASK-446 bug pin)", () => {
  it("two finals separated by a pause append in order, never clobber", () => {
    // Final 1 into an empty box.
    const r1 = computeVoiceInsert("", 0, "Hello there.");
    expect(r1.newValue).toBe("Hello there.");
    expect(r1.newAnchor).toBe("Hello there.".length);

    // Pause. Final 2 computes against the GROWN value with the ADVANCED
    // anchor - this is the exact sequence that used to overwrite.
    const r2 = computeVoiceInsert(r1.newValue, r1.newAnchor, "Second thought.");
    expect(r2.newValue).toBe("Hello there. Second thought.");
    expect(r2.newAnchor).toBe(r2.newValue.length);
  });

  it("three-final chain stays additive end to end", () => {
    let value = "";
    let anchor = 0;
    for (const text of ["one", "two", "three"]) {
      const r = computeVoiceInsert(value, anchor, text);
      value = r.newValue;
      anchor = r.newAnchor;
    }
    expect(value).toBe("one two three");
  });

  it("no-rerender burst: two finals with only the synchronous mirror between them (Atlas fold pin)", () => {
    // Simulates handleFinalText running twice in ONE frame: no render, no
    // effect - the only state carried between calls is the synchronous
    // mirror (value) and the anchor ref. Both inserts must land.
    const mirror = { value: "typed prefix", anchor: "typed prefix".length };
    for (const text of ["burst one", "burst two"]) {
      const r = computeVoiceInsert(mirror.value, mirror.anchor, text);
      mirror.value = r.newValue;
      mirror.anchor = r.newAnchor;
    }
    expect(mirror.value).toBe("typed prefix burst one burst two");
  });

  it("preserves text typed AFTER the anchor (shifted right, voice stream stays contiguous)", () => {
    // Anchor sits after "Voice:" - the user typed a suffix at the end.
    const value = "Voice: [typed suffix]";
    const anchor = "Voice:".length;
    const r = computeVoiceInsert(value, anchor, "dictated words");
    expect(r.newValue).toBe("Voice: dictated words [typed suffix]");
    // Next final lands directly after "dictated words", before the suffix.
    const r2 = computeVoiceInsert(r.newValue, r.newAnchor, "more words");
    expect(r2.newValue).toBe("Voice: dictated words more words [typed suffix]");
  });

  it("separator: space added after non-whitespace, none after newline or empty", () => {
    expect(computeVoiceInsert("end", 3, "x").newValue).toBe("end x");
    expect(computeVoiceInsert("line\n", 5, "x").newValue).toBe("line\nx");
    expect(computeVoiceInsert("", 0, "x").newValue).toBe("x");
    expect(computeVoiceInsert("trail ", 6, "x").newValue).toBe("trail x");
  });

  it("clamp is protective only: anchor beyond a shortened value appends at end", () => {
    // User deleted text, anchor now points past the end.
    const r = computeVoiceInsert("short", 50, "tail");
    expect(r.newValue).toBe("short tail");
    expect(r.newAnchor).toBe("short tail".length);
  });

  it("negative anchor clamps to start", () => {
    const r = computeVoiceInsert("abc", -5, "x");
    expect(r.newValue).toBe("xabc");
  });
});

// ---------------------------------------------------------------------------
// Activation-edge anchor selection (the 2026-06-14 stale/unfocused-anchor fix)
//
// Pure mirror of the voice-session activation-edge logic in Compose.tsx: at the
// isActive rising edge, pick the anchor from the CURRENT text mirror, honouring
// selectionStart only when the textarea genuinely holds focus. The vitest env
// is node (no DOM/hook render), so we mirror the decision exactly - same pattern
// as dispatchMessage in voice-compose.test.ts. Kept in sync with the effect.
// ---------------------------------------------------------------------------

/**
 * Mirror of the activation-edge anchor pick. `currentValue` is the synchronous
 * text mirror (currentTextRef.current). selectionStart is honoured only when
 * the textarea is focused; otherwise the anchor sits at the end of the text so
 * dictation appends.
 */
function pickActivationAnchor(
  currentValue: string,
  isFocused: boolean,
  selectionStart: number | null
): number {
  return isFocused && selectionStart !== null
    ? selectionStart
    : currentValue.length;
}

describe("activation-edge anchor selection (stale/unfocused-anchor fix)", () => {
  it("unfocused textarea with an existing draft anchors at the END, so voice appends (not prepends)", () => {
    // The bug: an unfocused textarea reports selectionStart=0, so the old code
    // anchored at 0 and the first final prepended into the draft.
    const draft = "existing draft text";
    const anchor = pickActivationAnchor(draft, false, 0);
    expect(anchor).toBe(draft.length);

    // Drive the insert with the picked anchor - the final must APPEND.
    const r = computeVoiceInsert(draft, anchor, "dictated tail");
    expect(r.newValue).toBe("existing draft text dictated tail");
  });

  it("focused textarea honours the user-placed cursor (TASK-433 insert-at-cursor preserved)", () => {
    const draft = "before after";
    const cursor = "before".length; // user clicked between the two words
    const anchor = pickActivationAnchor(draft, true, cursor);
    expect(anchor).toBe(cursor);

    const r = computeVoiceInsert(draft, anchor, "mid");
    expect(r.newValue).toBe("before mid after");
  });

  it("empty draft anchors at 0 regardless of focus (no regression on the fresh-box case)", () => {
    expect(pickActivationAnchor("", false, 0)).toBe(0);
    expect(pickActivationAnchor("", true, 0)).toBe(0);
    const r = computeVoiceInsert("", pickActivationAnchor("", false, 0), "first words");
    expect(r.newValue).toBe("first words");
  });

  it("falls back to end-of-text when selectionStart is null even if reported focused", () => {
    const draft = "some text";
    expect(pickActivationAnchor(draft, true, null)).toBe(draft.length);
  });
});

// ---------------------------------------------------------------------------
// isSpeechSignal - what re-arms the silence auto-stop timer
// ---------------------------------------------------------------------------

describe("isSpeechSignal - silence-timer reset gating (TASK-446 item 2)", () => {
  it("interim and final transcripts are speech signals", () => {
    expect(isSpeechSignal({ type: "interim", text: "hel" })).toBe(true);
    expect(isSpeechSignal({ type: "final", text: "hello" })).toBe(true);
  });

  it("machinery is NOT a speech signal", () => {
    expect(isSpeechSignal({ type: "status", state: "upstream_open" })).toBe(false);
    expect(isSpeechSignal({ type: "status", state: "no_key" })).toBe(false);
    expect(isSpeechSignal({ type: "dg_raw", text: "{...}" })).toBe(false);
    expect(isSpeechSignal({ type: "unknown" })).toBe(false);
    expect(isSpeechSignal(null)).toBe(false);
    expect(isSpeechSignal("final")).toBe(false);
    expect(isSpeechSignal({ type: "final" })).toBe(false); // no text field
    expect(isSpeechSignal({ type: "final", text: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SILENCE_AUTO_STOP_MS - the ticket's number, pinned
// ---------------------------------------------------------------------------

describe("SILENCE_AUTO_STOP_MS", () => {
  it("is 30 seconds (TASK-464: bumped from 10s so thinking pauses do not cut off dictation)", () => {
    expect(SILENCE_AUTO_STOP_MS).toBe(30_000);
  });
});
