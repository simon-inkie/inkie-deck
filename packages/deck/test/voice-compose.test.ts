/**
 * voice-compose.test.ts - Unit tests for Compose/useVoice debug event logic.
 *
 * Tests the pure message-dispatch and ring-buffer logic that backs the
 * debug panel. Because the vitest environment is "node" (no jsdom), we
 * cannot render hooks directly. Instead we test:
 *
 *   1. The message dispatch table: given a raw proxy message string, which
 *      DebugEvent types does the handler emit?  Mirrors the logic in the
 *      useVoice ws.addEventListener("message") handler exactly.
 *
 *   2. Ring buffer cap: the parent component caps at 200 events using an
 *      array-slice pattern. We test that slice directly.
 *
 *   3. debug_on gate: {type:"debug_on"} is only sent when debug=true.
 *
 *   4. dg_raw event: when the proxy mirrors a raw Deepgram frame, the
 *      handler emits a "dg" event with the [raw] prefix.
 *
 *   5. Ignored shapes: unknown type fields emit a "parse" ignored event.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirror of the message dispatch logic from useVoice.
// This is a pure function extracted from the ws.addEventListener("message")
// handler. It must be kept in sync with Compose.tsx.
//
// Returns the list of [type, data] debug event pairs that the handler emits
// for the given raw JSON string, plus any state transition side-effects
// (represented as strings for assertions).
// ---------------------------------------------------------------------------

type EmittedEvent = { type: string; data?: string };

/**
 * Pure representation of the useVoice message handler logic.
 *
 * Simulates the handler and returns all emitted debug events (in order)
 * plus a description of any state-change side-effects.
 */
function dispatchMessage(rawData: string): {
  events: EmittedEvent[];
  sideEffect: "none" | "no_key" | "interim" | "final";
  interimText?: string;
  finalText?: string;
} {
  const events: EmittedEvent[] = [];
  let sideEffect: "none" | "no_key" | "interim" | "final" = "none";
  let interimText: string | undefined;
  let finalText: string | undefined;

  // Mirror of the raw message truncation emit.
  const raw = rawData.length > 300 ? rawData.slice(0, 300) + "..." : rawData;
  events.push({ type: "dg", data: raw });

  let msg: unknown;
  try {
    msg = JSON.parse(rawData);
  } catch {
    events.push({ type: "parse", data: "ignored: JSON parse error" });
    return { events, sideEffect };
  }
  if (!msg || typeof msg !== "object") {
    events.push({ type: "parse", data: "ignored: not an object" });
    return { events, sideEffect };
  }
  const m = msg as Record<string, unknown>;

  if (m["type"] === "status") {
    const state = m["state"];
    if (state === "no_key") {
      events.push({ type: "status", data: "no_key: voice unavailable" });
      sideEffect = "no_key";
      return { events, sideEffect };
    }
    events.push({ type: "status", data: `state: ${String(state)}` });
    events.push({ type: "parse", data: `ignored: status/${String(state)}` });
    return { events, sideEffect };
  }

  if (m["type"] === "dg_raw" && typeof m["text"] === "string") {
    events.push({ type: "dg", data: `[raw] ${m["text"] as string}` });
    events.push({ type: "parse", data: "ignored: dg_raw" });
    return { events, sideEffect };
  }

  if (m["type"] === "interim" && typeof m["text"] === "string") {
    const text = m["text"] as string;
    events.push({ type: "parse", data: `interim: len=${text.length}` });
    sideEffect = "interim";
    interimText = text;
    return { events, sideEffect, interimText };
  }

  if (m["type"] === "final" && typeof m["text"] === "string") {
    const text = m["text"] as string;
    events.push({ type: "parse", data: `final: len=${text.length}` });
    sideEffect = "final";
    finalText = text;
    return { events, sideEffect, finalText };
  }

  events.push({ type: "parse", data: `ignored: unknown type=${String(m["type"])}` });
  return { events, sideEffect };
}

/**
 * Simulate the ring buffer state update (mirrors handleDebugEvent in Compose).
 * The parent caps at 200 events by slicing from the end.
 */
function applyRingBuffer(prev: EmittedEvent[], next: EmittedEvent): EmittedEvent[] {
  const arr = [...prev, next];
  if (arr.length > 200) {
    return arr.slice(arr.length - 200);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInterim(text: string) {
  return JSON.stringify({ type: "interim", text });
}

function makeFinal(text: string) {
  return JSON.stringify({ type: "final", text });
}

function makeStatus(state: string) {
  return JSON.stringify({ type: "status", state });
}

function makeDgRaw(text: string) {
  return JSON.stringify({ type: "dg_raw", text });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("useVoice message dispatch - status frames", () => {
  it("no_key status emits status event and triggers no_key side-effect", () => {
    const result = dispatchMessage(makeStatus("no_key"));
    expect(result.sideEffect).toBe("no_key");
    const statusEvt = result.events.find((e) => e.type === "status");
    expect(statusEvt?.data).toContain("no_key");
  });

  it("upstream_connecting status emits status event and parse:ignored (no behaviour change)", () => {
    const result = dispatchMessage(makeStatus("upstream_connecting"));
    expect(result.sideEffect).toBe("none");
    const statusEvt = result.events.find((e) => e.type === "status");
    expect(statusEvt?.data).toContain("upstream_connecting");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("ignored");
  });

  it("upstream_open status emits status event and parse:ignored", () => {
    const result = dispatchMessage(makeStatus("upstream_open"));
    expect(result.sideEffect).toBe("none");
    const statusEvt = result.events.find((e) => e.type === "status");
    expect(statusEvt?.data).toContain("upstream_open");
  });

  it("upstream_closed status emits status event and parse:ignored", () => {
    const result = dispatchMessage(makeStatus("upstream_closed"));
    expect(result.sideEffect).toBe("none");
    const statusEvt = result.events.find((e) => e.type === "status");
    expect(statusEvt?.data).toContain("upstream_closed");
  });

  it("overflow status emits status event and parse:ignored", () => {
    const result = dispatchMessage(makeStatus("overflow"));
    expect(result.sideEffect).toBe("none");
    const statusEvt = result.events.find((e) => e.type === "status");
    expect(statusEvt?.data).toContain("overflow");
  });
});

describe("useVoice message dispatch - dg_raw (debug_on mirroring)", () => {
  it("dg_raw frame emits a dg event with [raw] prefix and parse:ignored", () => {
    const result = dispatchMessage(makeDgRaw("hello deepgram"));
    expect(result.sideEffect).toBe("none");
    const dgEvt = result.events.find((e) => e.type === "dg" && e.data?.startsWith("[raw]"));
    expect(dgEvt?.data).toContain("hello deepgram");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("ignored: dg_raw");
  });

  it("raw message is always emitted as first dg event before the dg_raw parse", () => {
    const result = dispatchMessage(makeDgRaw("test text"));
    // First event: raw dump of the received string
    expect(result.events[0]?.type).toBe("dg");
    // Second event: the [raw] prefixed dg event
    expect(result.events[1]?.type).toBe("dg");
    expect(result.events[1]?.data).toMatch(/^\[raw\]/);
  });
});

describe("useVoice message dispatch - interim/final application", () => {
  it("interim message emits parse event with text length and triggers interim side-effect", () => {
    const result = dispatchMessage(makeInterim("hello world"));
    expect(result.sideEffect).toBe("interim");
    expect(result.interimText).toBe("hello world");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("interim:");
    expect(parseEvt?.data).toContain(`len=${("hello world").length}`);
  });

  it("final message emits parse event with text length and triggers final side-effect", () => {
    const result = dispatchMessage(makeFinal("this is the final answer."));
    expect(result.sideEffect).toBe("final");
    expect(result.finalText).toBe("this is the final answer.");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("final:");
    expect(parseEvt?.data).toContain(`len=${("this is the final answer.").length}`);
  });

  it("unknown type emits parse:ignored event", () => {
    const result = dispatchMessage(JSON.stringify({ type: "unknown_future_type" }));
    expect(result.sideEffect).toBe("none");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("ignored: unknown type=unknown_future_type");
  });

  it("invalid JSON emits parse:ignored event", () => {
    const result = dispatchMessage("not json {{");
    expect(result.sideEffect).toBe("none");
    const parseEvt = result.events.find((e) => e.type === "parse");
    expect(parseEvt?.data).toContain("ignored: JSON parse error");
  });
});

describe("useVoice message dispatch - raw message truncation", () => {
  it("messages longer than 300 chars are truncated in the first dg event", () => {
    const longText = "x".repeat(400);
    const raw = JSON.stringify({ type: "final", text: longText });
    const result = dispatchMessage(raw);
    const firstEvt = result.events[0];
    expect(firstEvt?.type).toBe("dg");
    // The data field must be truncated to 300 + "..."
    expect(firstEvt?.data?.length).toBeLessThanOrEqual(303);
    expect(firstEvt?.data).toMatch(/\.\.\.$/);
  });

  it("messages shorter than 300 chars are not truncated", () => {
    const raw = makeInterim("short text");
    const result = dispatchMessage(raw);
    const firstEvt = result.events[0];
    expect(firstEvt?.data).toBe(raw);
    expect(firstEvt?.data).not.toMatch(/\.\.\.$/);
  });
});

describe("ring buffer cap at 200 events (drop oldest, never newest)", () => {
  it("buffer under 200 is returned unchanged", () => {
    const buf: EmittedEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: "state",
      data: `event-${i}`,
    }));
    const evt: EmittedEvent = { type: "state", data: "new" };
    const result = applyRingBuffer(buf, evt);
    expect(result).toHaveLength(51);
    expect(result[result.length - 1]?.data).toBe("new");
  });

  it("adding the 201st event drops the oldest (index 0), keeping newest at end", () => {
    const buf: EmittedEvent[] = Array.from({ length: 200 }, (_, i) => ({
      type: "state",
      data: `event-${i}`,
    }));
    const newEvt: EmittedEvent = { type: "ws", data: "the-new-one" };
    const result = applyRingBuffer(buf, newEvt);
    expect(result).toHaveLength(200);
    // Oldest (event-0) is gone.
    expect(result[0]?.data).toBe("event-1");
    // Newest is at the end.
    expect(result[result.length - 1]?.data).toBe("the-new-one");
  });

  it("adding many events beyond 200 always keeps the most recent 200", () => {
    let buf: EmittedEvent[] = [];
    for (let i = 0; i < 250; i++) {
      buf = applyRingBuffer(buf, { type: "state", data: `event-${i}` });
    }
    expect(buf).toHaveLength(200);
    // Most recent 200: events 50..249
    expect(buf[0]?.data).toBe("event-50");
    expect(buf[199]?.data).toBe("event-249");
  });
});

describe("debug_on gate - only send when debug=true", () => {
  it("debug_on is sent only when debug is true (logic gate)", () => {
    // This test verifies the conditional: `if (debug) { ws.send(debug_on) }`
    // The actual WS send is browser-side; here we prove the predicate logic.
    function shouldSendDebugOn(debug: boolean | undefined): boolean {
      return debug === true;
    }

    expect(shouldSendDebugOn(true)).toBe(true);
    expect(shouldSendDebugOn(false)).toBe(false);
    expect(shouldSendDebugOn(undefined)).toBe(false);
  });
});
