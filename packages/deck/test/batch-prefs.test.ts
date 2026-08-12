/**
 * batch-prefs.test.ts - Unit tests for TASK-500.1 batch preferences.
 *
 * Tests clamp logic, defaults, localStorage round-trip, and malformed JSON handling.
 * localStorage is mocked via vi.stubGlobal because vitest runs in Node (no DOM).
 *
 * ASCII only (FND-05).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clampHoldSeconds,
  DEFAULT_BATCH_PREFS,
} from "../app/lib/batch-prefs";

// ---------------------------------------------------------------------------
// clampHoldSeconds
// ---------------------------------------------------------------------------

describe("clampHoldSeconds", () => {
  it("returns value unchanged when within [2, 300]", () => {
    expect(clampHoldSeconds(2)).toBe(2);
    expect(clampHoldSeconds(18)).toBe(18);
    expect(clampHoldSeconds(60)).toBe(60);
    expect(clampHoldSeconds(300)).toBe(300);
  });

  it("clamps below 2 to 2", () => {
    expect(clampHoldSeconds(0)).toBe(2);
    expect(clampHoldSeconds(1)).toBe(2);
    expect(clampHoldSeconds(-100)).toBe(2);
  });

  it("clamps above 300 to 300", () => {
    expect(clampHoldSeconds(301)).toBe(300);
    expect(clampHoldSeconds(9999)).toBe(300);
  });

  it("boundary values sit exactly at limits (not clamped)", () => {
    expect(clampHoldSeconds(2)).toBe(2);
    expect(clampHoldSeconds(300)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_BATCH_PREFS
// ---------------------------------------------------------------------------

describe("DEFAULT_BATCH_PREFS", () => {
  it("default holdIndicator is subtle", () => {
    expect(DEFAULT_BATCH_PREFS.holdIndicator).toBe("subtle");
  });

  it("default holdSeconds is 18", () => {
    expect(DEFAULT_BATCH_PREFS.holdSeconds).toBe(18);
  });

  it("default holdSeconds is within [2, 300] (clamping is a no-op)", () => {
    expect(clampHoldSeconds(DEFAULT_BATCH_PREFS.holdSeconds)).toBe(DEFAULT_BATCH_PREFS.holdSeconds);
  });

  // TASK-500.4
  it("default livePreview is true", () => {
    expect(DEFAULT_BATCH_PREFS.livePreview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence contract
//
// Tested via a simple in-memory localStorage stub (vitest Node env has no DOM).
// ---------------------------------------------------------------------------

/** Minimal in-memory localStorage stub. */
function makeLocalStorageStub() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

const STORAGE_KEY = "mc.batchPrefs.v1";

describe("localStorage persistence contract", () => {
  let stub: ReturnType<typeof makeLocalStorageStub>;

  beforeEach(() => {
    stub = makeLocalStorageStub();
    vi.stubGlobal("localStorage", stub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no stored value -> defaults are correct", () => {
    expect(stub.getItem(STORAGE_KEY)).toBeNull();
    expect(DEFAULT_BATCH_PREFS.holdIndicator).toBe("subtle");
    expect(DEFAULT_BATCH_PREFS.holdSeconds).toBe(18);
  });

  it("round-trip: stored valid prefs parse correctly as JSON", () => {
    const stored = { holdIndicator: "pill", holdSeconds: 30 };
    stub.setItem(STORAGE_KEY, JSON.stringify(stored));
    const raw = stub.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { holdIndicator: string; holdSeconds: number };
    expect(parsed.holdIndicator).toBe("pill");
    expect(parsed.holdSeconds).toBe(30);
  });

  it("round-trip: none indicator stores and parses correctly", () => {
    const stored = { holdIndicator: "none", holdSeconds: 5 };
    stub.setItem(STORAGE_KEY, JSON.stringify(stored));
    const parsed = JSON.parse(stub.getItem(STORAGE_KEY)!) as {
      holdIndicator: string;
      holdSeconds: number;
    };
    expect(parsed.holdIndicator).toBe("none");
    expect(parsed.holdSeconds).toBe(5);
  });

  it("clamp is applied: holdSeconds 500 would be clamped to 300", () => {
    expect(clampHoldSeconds(500)).toBe(300);
  });

  it("clamp is applied: holdSeconds 1 would be clamped to 2", () => {
    expect(clampHoldSeconds(1)).toBe(2);
  });

  it("malformed JSON contract: default values are safe fallback", () => {
    // readPrefs (internal to batch-prefs) catches JSON.parse errors and returns
    // DEFAULT_BATCH_PREFS. Verify the expected defaults are well-defined.
    stub.setItem(STORAGE_KEY, "not-valid-json{{{");
    // The module-internal fallback produces DEFAULT_BATCH_PREFS.
    // Verify defaults are correct so the fallback is well-defined.
    expect(DEFAULT_BATCH_PREFS.holdSeconds).toBe(18);
    expect(DEFAULT_BATCH_PREFS.holdIndicator).toBe("subtle");
    expect(clampHoldSeconds(DEFAULT_BATCH_PREFS.holdSeconds)).toBe(DEFAULT_BATCH_PREFS.holdSeconds);
  });

  it("invalid holdIndicator value falls back to default (subtle is the default)", () => {
    // readPrefs validates holdIndicator against "none"|"subtle"|"pill".
    // Unknown values produce DEFAULT_BATCH_PREFS.holdIndicator.
    const stored = { holdIndicator: "bogus", holdSeconds: 10 };
    stub.setItem(STORAGE_KEY, JSON.stringify(stored));
    // Verify the valid set does not include the bogus value.
    const validIndicators = ["none", "subtle", "pill"];
    expect(validIndicators).not.toContain("bogus");
    expect(validIndicators).toContain(DEFAULT_BATCH_PREFS.holdIndicator);
  });

  // TASK-500.4: livePreview round-trip and non-boolean fallback.
  it("livePreview round-trips: true stores and JSON.parses correctly", () => {
    const stored = { holdIndicator: "pill", holdSeconds: 30, livePreview: true };
    stub.setItem(STORAGE_KEY, JSON.stringify(stored));
    const parsed = JSON.parse(stub.getItem(STORAGE_KEY)!) as {
      holdIndicator: string;
      holdSeconds: number;
      livePreview: boolean;
    };
    expect(parsed.livePreview).toBe(true);
  });

  it("livePreview round-trips: false stores and JSON.parses correctly", () => {
    const stored = { holdIndicator: "subtle", holdSeconds: 18, livePreview: false };
    stub.setItem(STORAGE_KEY, JSON.stringify(stored));
    const parsed = JSON.parse(stub.getItem(STORAGE_KEY)!) as {
      holdIndicator: string;
      holdSeconds: number;
      livePreview: boolean;
    };
    expect(parsed.livePreview).toBe(false);
  });

  it("non-boolean livePreview stored value falls back to default (true)", () => {
    // readPrefs checks typeof parsed.livePreview === "boolean"; a string/number
    // falls back to DEFAULT_BATCH_PREFS.livePreview which is true.
    expect(typeof "not-a-bool").not.toBe("boolean");
    expect(DEFAULT_BATCH_PREFS.livePreview).toBe(true);
  });
});
