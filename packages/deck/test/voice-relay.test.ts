/**
 * voice-relay.test.ts - Unit tests for server/voice-relay.{ts,mjs}
 *
 * Tests the pure message-mapping logic without any real sockets or Deepgram calls.
 *
 * NOTE ON WHICH FILE IS UNDER TEST. This header used to say "voice-relay.mjs",
 * which was wrong and was load-bearing in being wrong: the imports below go to
 * "../server/voice-relay.js", which has no literal file behind it, so vite
 * resolves it to voice-relay.TS. The running proxy imports voice-relay.MJS.
 * Two hand-maintained copies, and only the untested one runs. The cross-copy
 * suite at the bottom is what makes this file mean something about production.
 *
 * Coverage:
 *   - Interim/final mapping matrix (is_final true/false, non-empty/empty text)
 *   - Non-Results event types return null
 *   - Invalid JSON returns null
 *   - no-key handshake shape
 *   - KEY-NEVER-DOWNSTREAM: with a fake key string in scope, assert no
 *     emitted message contains it
 *   - upstream-close mapping: null (close is handled at socket level, not relay)
 *   - makeFrameBuffer: in-order flush, overflow at frame-count bound, overflow
 *     at byte bound, empty flush, connecting->open delivery
 *   - statusFrame: all valid states produce the correct shape, upstream_error
 *     carries its cause in `detail`, and `detail` is OMITTED when absent so
 *     pre-existing frames serialise unchanged
 *   - cross-copy agreement: .ts and .mjs return identical statusFrame output
 *     for every state, and identical mapUpstreamMessage output for the shapes
 *     Deepgram actually sends. One known divergence is recorded as a todo.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import {
  mapUpstreamMessage,
  noKeyHandshake,
  isOriginAllowed,
  makeFrameBuffer,
  statusFrame,
  buildDeepgramUrlQuery,
  DEFAULT_KEYTERMS,
  DEFAULT_REPLACEMENTS,
} from "../server/voice-relay.js";

// The RUNTIME copy, imported deliberately alongside the one above.
//
// "../server/voice-relay.js" has no literal file behind it; vite resolves it to
// voice-relay.ts. But voice-proxy.mjs:39 imports voice-relay.MJS, so until this
// second import existed every test in this file was green regardless of what
// the running proxy did. See the cross-copy suite at the bottom.
import {
  mapUpstreamMessage as mapUpstreamMessageMjs,
  statusFrame as statusFrameMjs,
} from "../server/voice-relay.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeepgramResults(opts: {
  transcript: string;
  is_final: boolean;
  speech_final?: boolean;
}) {
  return JSON.stringify({
    type: "Results",
    is_final: opts.is_final,
    speech_final: opts.speech_final ?? false,
    channel: {
      alternatives: [{ transcript: opts.transcript, confidence: 0.99 }],
    },
  });
}

// ---------------------------------------------------------------------------
// Suite: interim / final mapping
// ---------------------------------------------------------------------------

describe("mapUpstreamMessage - interim/final mapping", () => {
  it("maps is_final=false with text to {type:interim, text}", () => {
    const raw = makeDeepgramResults({ transcript: "hello world", is_final: false });
    const result = mapUpstreamMessage(raw);
    expect(result).toEqual({ type: "interim", text: "hello world" });
  });

  it("maps is_final=true with text to {type:final, text}", () => {
    const raw = makeDeepgramResults({ transcript: "hello world.", is_final: true });
    const result = mapUpstreamMessage(raw);
    expect(result).toEqual({ type: "final", text: "hello world." });
  });

  it("returns null for is_final=false with empty transcript", () => {
    const raw = makeDeepgramResults({ transcript: "", is_final: false });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null for is_final=true with empty transcript", () => {
    const raw = makeDeepgramResults({ transcript: "", is_final: true });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null for non-Results type (Metadata)", () => {
    const raw = JSON.stringify({ type: "Metadata", transaction_key: "abc" });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null for SpeechStarted events", () => {
    const raw = JSON.stringify({ type: "SpeechStarted" });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null for UtteranceEnd events", () => {
    const raw = JSON.stringify({ type: "UtteranceEnd" });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const result = mapUpstreamMessage("not json at all {{{");
    expect(result).toBeNull();
  });

  it("returns null when channel.alternatives is missing", () => {
    const raw = JSON.stringify({ type: "Results", is_final: false, channel: {} });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null when channel is missing entirely", () => {
    const raw = JSON.stringify({ type: "Results", is_final: false });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });

  it("returns null when channel.alternatives is empty", () => {
    const raw = JSON.stringify({
      type: "Results",
      is_final: false,
      channel: { alternatives: [] },
    });
    const result = mapUpstreamMessage(raw);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: no-key handshake shape
// ---------------------------------------------------------------------------

describe("noKeyHandshake", () => {
  it("returns the correct no_key status shape", () => {
    const msg = noKeyHandshake();
    expect(msg).toEqual({ type: "status", state: "no_key" });
  });

  it("is JSON-serialisable", () => {
    const msg = noKeyHandshake();
    expect(() => JSON.stringify(msg)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(msg));
    expect(parsed.type).toBe("status");
    expect(parsed.state).toBe("no_key");
  });
});

// ---------------------------------------------------------------------------
// Suite: KEY-NEVER-DOWNSTREAM
// Paranoid check: with a known fake key string, assert that no message emitted
// by mapUpstreamMessage or noKeyHandshake contains it.
// ---------------------------------------------------------------------------

describe("KEY-NEVER-DOWNSTREAM", () => {
  const FAKE_KEY = "dg_sk_AAABBBCCC999FakeKeyForTestingOnly";

  it("mapUpstreamMessage does not leak the key in interim output", () => {
    const raw = makeDeepgramResults({ transcript: "testing one two", is_final: false });
    const result = mapUpstreamMessage(raw);
    expect(result).not.toBeNull();
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_KEY);
  });

  it("mapUpstreamMessage does not leak the key in final output", () => {
    const raw = makeDeepgramResults({ transcript: "final result text", is_final: true });
    const result = mapUpstreamMessage(raw);
    expect(result).not.toBeNull();
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_KEY);
  });

  it("noKeyHandshake does not contain the fake key", () => {
    const msg = noKeyHandshake();
    const serialised = JSON.stringify(msg);
    expect(serialised).not.toContain(FAKE_KEY);
  });

  it("mapUpstreamMessage output has only type and text fields (no exfil surface)", () => {
    const raw = makeDeepgramResults({ transcript: "hello", is_final: true });
    const result = mapUpstreamMessage(raw);
    expect(result).not.toBeNull();
    if (result !== null) {
      const keys = Object.keys(result).sort();
      expect(keys).toEqual(["text", "type"]);
    }
  });
});

describe("isOriginAllowed (the keyhole fold)", () => {
  const allowed = ["http://localhost:5174"];

  it("allows an exact-match origin", () => {
    expect(isOriginAllowed("http://localhost:5174", allowed)).toBe(true);
  });

  it("rejects a non-matching origin (hostile webpage)", () => {
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
  });

  it("rejects an ABSENT origin (non-browser client must not ride the proxy)", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });

  it("rejects a prefix-confusable origin", () => {
    expect(isOriginAllowed("http://localhost:5174.evil.example", allowed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: makeFrameBuffer
// Verifies the pure buffer helper preserves frame order and
// enforces bounds without ever dropping the oldest frame.
// ---------------------------------------------------------------------------

describe("makeFrameBuffer", () => {
  it("push returns ok and flush returns frames in-order (the connecting->open delivery)", () => {
    const buf = makeFrameBuffer(200, 2 * 1024 * 1024);
    const frame1 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // fake EBML header bytes
    const frame2 = Buffer.from([0xaa, 0xbb]);
    const frame3 = Buffer.from([0xcc]);

    expect(buf.push(frame1)).toBe("ok");
    expect(buf.push(frame2)).toBe("ok");
    expect(buf.push(frame3)).toBe("ok");
    expect(buf.frameCount()).toBe(3);

    const flushed = buf.flush();
    expect(flushed).toHaveLength(3);
    // Frames arrive in-order: frame1 first (the webm container header must be first).
    expect(flushed[0]).toBe(frame1);
    expect(flushed[1]).toBe(frame2);
    expect(flushed[2]).toBe(frame3);
  });

  it("flush after flush returns empty array (buffer is cleared)", () => {
    const buf = makeFrameBuffer();
    buf.push(Buffer.from([0x01]));
    buf.flush();
    expect(buf.flush()).toHaveLength(0);
    expect(buf.frameCount()).toBe(0);
    expect(buf.byteCount()).toBe(0);
  });

  it("empty flush returns empty array", () => {
    const buf = makeFrameBuffer();
    expect(buf.flush()).toHaveLength(0);
  });

  it("overflow at frame-count bound: returns overflow instead of accepting the (N+1)th frame", () => {
    // Small maxFrames to exercise the bound without allocating 200 frames.
    const buf = makeFrameBuffer(3, 2 * 1024 * 1024);
    const tiny = Buffer.from([0x00]);
    expect(buf.push(tiny)).toBe("ok");
    expect(buf.push(tiny)).toBe("ok");
    expect(buf.push(tiny)).toBe("ok");
    // Fourth push must overflow, not drop the oldest.
    expect(buf.push(tiny)).toBe("overflow");
    // The three already-queued frames are still intact.
    expect(buf.frameCount()).toBe(3);
  });

  it("overflow at byte-count bound: returns overflow when total bytes would exceed limit", () => {
    // maxBytes=10; push two 6-byte frames; the second would exceed the limit.
    const buf = makeFrameBuffer(200, 10);
    const sixBytes = Buffer.from([1, 2, 3, 4, 5, 6]);
    expect(buf.push(sixBytes)).toBe("ok");
    expect(buf.byteCount()).toBe(6);
    // 6 + 6 = 12 > 10 -> overflow
    expect(buf.push(sixBytes)).toBe("overflow");
    // First frame is still intact (never dropped).
    expect(buf.frameCount()).toBe(1);
    expect(buf.byteCount()).toBe(6);
  });

  it("byteCount tracks the running total correctly", () => {
    const buf = makeFrameBuffer();
    buf.push(Buffer.alloc(100));
    buf.push(Buffer.alloc(200));
    expect(buf.byteCount()).toBe(300);
  });

  it("byteCount resets to 0 after flush", () => {
    const buf = makeFrameBuffer();
    buf.push(Buffer.alloc(100));
    buf.flush();
    expect(buf.byteCount()).toBe(0);
  });

  it("exactly-at-bound frame push is ok; one byte over triggers overflow", () => {
    // maxBytes=5; a 5-byte frame fits exactly; a 1-byte push after that overflows.
    const buf = makeFrameBuffer(200, 5);
    expect(buf.push(Buffer.alloc(5))).toBe("ok");
    expect(buf.push(Buffer.alloc(1))).toBe("overflow");
  });
});

// ---------------------------------------------------------------------------
// Suite: statusFrame
// ---------------------------------------------------------------------------

describe("statusFrame", () => {
  it("returns upstream_connecting shape", () => {
    expect(statusFrame("upstream_connecting")).toEqual({
      type: "status",
      state: "upstream_connecting",
    });
  });

  it("returns upstream_open shape", () => {
    expect(statusFrame("upstream_open")).toEqual({
      type: "status",
      state: "upstream_open",
    });
  });

  it("returns upstream_closed shape", () => {
    expect(statusFrame("upstream_closed")).toEqual({
      type: "status",
      state: "upstream_closed",
    });
  });

  it("returns overflow shape", () => {
    expect(statusFrame("overflow")).toEqual({
      type: "status",
      state: "overflow",
    });
  });

  it("returns no_key shape (consistent with noKeyHandshake)", () => {
    expect(statusFrame("no_key")).toEqual(noKeyHandshake());
  });

  it("returns upstream_error shape with the cause attached", () => {
    expect(statusFrame("upstream_error", "Unexpected server response: 400")).toEqual({
      type: "status",
      state: "upstream_error",
      detail: "Unexpected server response: 400",
    });
  });

  it("omits detail entirely when absent, so pre-existing frames are unchanged", () => {
    // Not just "detail is undefined" - the KEY is absent, so JSON output for
    // every state that existed before this change is byte-identical.
    expect(JSON.stringify(statusFrame("upstream_closed"))).toBe(
      '{"type":"status","state":"upstream_closed"}'
    );
    expect(Object.hasOwn(statusFrame("upstream_error"), "detail")).toBe(false);
  });

  it("all status frames are JSON-serialisable", () => {
    const states = [
      "no_key",
      "upstream_connecting",
      "upstream_open",
      "upstream_closed",
      "upstream_error",
      "overflow",
    ] as const;
    for (const state of states) {
      const frame = statusFrame(state);
      expect(() => JSON.stringify(frame)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(frame));
      expect(parsed.type).toBe("status");
      expect(parsed.state).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: cross-copy agreement (voice-relay.ts vs voice-relay.mjs)
//
// WHY THIS EXISTS. server/voice-relay.ts and server/voice-relay.mjs are two
// hand-maintained copies of the same logic; voice-relay.ts:5 says so in its own
// header. voice-proxy.mjs imports the .MJS at runtime, and every other suite in
// this file imports the .TS. So without this suite the whole file could be
// green while the running proxy behaved differently, which is not a
// hypothetical: the two copies are known to diverge today (see the todo below).
//
// Byte-equality cannot express this pair, because .ts and .mjs are legitimately
// different text. Shared behavioural vectors are the instrument instead.
// ---------------------------------------------------------------------------

describe("cross-copy agreement: voice-relay.ts vs voice-relay.mjs", () => {
  const ALL_STATES = [
    "no_key",
    "upstream_connecting",
    "upstream_open",
    "upstream_closed",
    "upstream_error",
    "overflow",
  ] as const;

  it("statusFrame agrees on every state, with and without detail", () => {
    for (const state of ALL_STATES) {
      expect(statusFrameMjs(state)).toEqual(statusFrame(state));
      expect(JSON.stringify(statusFrameMjs(state))).toBe(
        JSON.stringify(statusFrame(state))
      );

      const withDetail = "Unexpected server response: 400";
      expect(statusFrameMjs(state, withDetail)).toEqual(
        statusFrame(state, withDetail)
      );
      expect(JSON.stringify(statusFrameMjs(state, withDetail))).toBe(
        JSON.stringify(statusFrame(state, withDetail))
      );
    }
  });

  it("statusFrame omits detail identically in both copies", () => {
    expect(Object.hasOwn(statusFrameMjs("upstream_error"), "detail")).toBe(
      Object.hasOwn(statusFrame("upstream_error"), "detail")
    );
  });

  it("mapUpstreamMessage agrees on the shapes Deepgram actually sends", () => {
    const cases = [
      { type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hello" }] } },
      { type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hi" }] } },
      { type: "Results", is_final: true, channel: { alternatives: [{ transcript: "" }] } },
      { type: "Metadata", model_info: {} },
      { type: "Results", is_final: true, channel: {} },
      { type: "Results", is_final: true, channel: null },
    ];
    for (const c of cases) {
      const raw = JSON.stringify(c);
      expect(mapUpstreamMessageMjs(raw)).toEqual(mapUpstreamMessage(raw));
    }
    expect(mapUpstreamMessageMjs("not json")).toEqual(mapUpstreamMessage("not json"));
  });

  // Previously a KNOWN DIVERGENCE: .mjs forwarded a
  // non-string transcript (alternatives[0]?.transcript ?? "") where .ts
  // rejected it (typeof guard). Fixed by adding the same guard to .mjs; both
  // copies now agree on a malformed/adversarial upstream, not just a
  // well-formed one.
  it("mapUpstreamMessage rejects a non-string transcript identically in both copies", () => {
    const raw = JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: 123 }] },
    });
    expect(mapUpstreamMessageMjs(raw)).toBeNull();
    expect(mapUpstreamMessage(raw)).toBeNull();
    expect(mapUpstreamMessageMjs(raw)).toEqual(mapUpstreamMessage(raw));
  });
});

// ---------------------------------------------------------------------------
// buildDeepgramUrlQuery - keyterm prompting
// ---------------------------------------------------------------------------

describe("buildDeepgramUrlQuery", () => {
  it("includes model, language and the fixed flags", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [],
    });
    const params = new URLSearchParams(query);
    expect(params.get("model")).toBe("nova-3");
    expect(params.get("language")).toBe("en-GB");
    expect(params.get("smart_format")).toBe("true");
    expect(params.get("punctuate")).toBe("true");
    expect(params.get("interim_results")).toBe("true");
  });

  it("emits REPEATED keyterm params, not a comma-joined value", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: ["Quill", "Atlas"],
      replacements: [],
    });
    // Deepgram rejects a single comma-joined keyterm value; this is the
    // behavioural contract, not just a shape check.
    expect(query).not.toContain("keyterm=Quill%2CAtlas");
    expect(query).not.toContain("keyterm=Quill,Atlas");
    const matches = [...query.matchAll(/keyterm=([^&]+)/g)].map((m) =>
      decodeURIComponent(m[1] ?? "")
    );
    expect(matches).toEqual(["Quill", "Atlas"]);
  });

  it("percent-encodes a keyterm containing special characters", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: ["Summit Two"],
      replacements: [],
    });
    expect(query).toContain("keyterm=Summit%20Two");
  });

  it("produces no keyterm params for an empty list", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [],
    });
    expect(query).not.toContain("keyterm=");
  });

  it("DEFAULT_KEYTERMS carries the demo coordinator", () => {
    expect(DEFAULT_KEYTERMS).toContain("Quill");
  });

  it("DEFAULT_KEYTERMS has no duplicate entries", () => {
    expect(new Set(DEFAULT_KEYTERMS).size).toBe(DEFAULT_KEYTERMS.length);
  });

  it("emits a replace=find:replacement param with a literal colon separator", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [{ find: "inky", replace: "Inkie" }],
    });
    expect(query).toContain("replace=inky:Inkie");
  });

  it("emits REPEATED replace params, not a comma-joined value, for multiple pairs", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [
        { find: "inky", replace: "Inkie" },
        { find: "kpis", replace: "Key Performance Indicators" },
      ],
    });
    const matches = [...query.matchAll(/replace=([^&]+)/g)].map((m) =>
      decodeURIComponent(m[1] ?? "")
    );
    expect(matches).toEqual(["inky:Inkie", "kpis:Key Performance Indicators"]);
  });

  it("percent-encodes special characters in find/replacement but leaves the separating colon literal", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [{ find: "kpis", replace: "Key Performance Indicators" }],
    });
    expect(query).toContain("replace=kpis:Key%20Performance%20Indicators");
    expect(query).not.toContain("replace=kpis%3AKey");
  });

  it("percent-encodes reserved characters on the find side too, not just the replacement", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [{ find: "r&d", replace: "R&D: Research & Development" }],
    });
    // Each side is encoded independently, so a literal "&" or ":" inside
    // either one comes out percent-encoded, and only the SEPARATING colon
    // (inserted by buildDeepgramUrlQuery itself) stays literal.
    expect(query).toContain(
      "replace=r%26d:R%26D%3A%20Research%20%26%20Development",
    );
  });

  it("produces no replace param for an empty replacements list", () => {
    const query = buildDeepgramUrlQuery({
      model: "nova-3",
      language: "en-GB",
      keyterms: [],
      replacements: [],
    });
    expect(query).not.toContain("replace=");
  });

  it("DEFAULT_REPLACEMENTS contains the inky -> Inkie mapping", () => {
    expect(DEFAULT_REPLACEMENTS).toContainEqual({ find: "inky", replace: "Inkie" });
  });

  it("DEFAULT_REPLACEMENTS find values are all lowercase (Deepgram requires this)", () => {
    for (const r of DEFAULT_REPLACEMENTS) {
      expect(r.find).toBe(r.find.toLowerCase());
    }
  });
});
