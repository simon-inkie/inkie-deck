/**
 * RED tests for app/lib/time.ts
 * Verifies: pure formatAbsolute and formatRelative against injected clock.
 * Both functions must be deterministic for fixed inputs (no wall-clock reads).
 */
import { describe, it, expect } from "vitest";
import {
  resolveNow,
  formatAbsolute,
  formatRelative,
  formatClockTime,
  londonDayKey,
  formatDayDivider,
  formatCardStamp,
  formatCardTooltip,
} from "~/lib/time.js";

// Fixed reference point for deterministic tests
const FIXED_ISO = "2026-06-01T10:00:00Z";
const FIXED_NOW = new Date("2026-06-03T10:00:00Z"); // 2 days after FIXED_ISO

describe("formatAbsolute", () => {
  it("returns a string for a valid ISO timestamp", () => {
    const result = formatAbsolute(FIXED_ISO);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns an ASCII-only string (no em-dashes or multi-byte chars from date-fns)", () => {
    const result = formatAbsolute(FIXED_ISO);
    // Should be a fixed ASCII pattern like "2026-06-01 10:00"
    expect(result).toMatch(/^[\x20-\x7E]+$/);
  });

  it("formats the date in yyyy-MM-dd HH:mm pattern", () => {
    const result = formatAbsolute(FIXED_ISO);
    expect(result).toBe("2026-06-01 10:00");
  });

  it("two calls with the same input return the same output (pure)", () => {
    const a = formatAbsolute(FIXED_ISO);
    const b = formatAbsolute(FIXED_ISO);
    expect(a).toBe(b);
  });
});

describe("formatRelative", () => {
  it("returns a string for a valid (iso, now) pair", () => {
    const result = formatRelative(FIXED_ISO, FIXED_NOW);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("with injected now that is 2 days later returns '2 days ago'", () => {
    const result = formatRelative(FIXED_ISO, FIXED_NOW);
    // date-fns formatDistanceToNow with addSuffix gives "2 days ago" for exactly 2 days
    expect(result).toBe("2 days ago");
  });

  it("two calls with the same (iso, now) return the same output (deterministic)", () => {
    const a = formatRelative(FIXED_ISO, FIXED_NOW);
    const b = formatRelative(FIXED_ISO, FIXED_NOW);
    expect(a).toBe(b);
  });

  it("future date returns 'in X days' style string", () => {
    const pastNow = new Date("2026-05-30T10:00:00Z"); // 2 days before FIXED_ISO
    const result = formatRelative(FIXED_ISO, pastNow);
    expect(result).toContain("in");
  });

  it("uses injected now, not the real wall clock (determinism proof)", () => {
    // If the function uses the real clock, this would return a different result
    // in a few seconds. By injecting a fixed now, we get stable output.
    const result1 = formatRelative(FIXED_ISO, FIXED_NOW);
    const result2 = formatRelative(FIXED_ISO, FIXED_NOW);
    expect(result1).toBe(result2);
  });
});

describe("formatClockTime", () => {
  it("renders Europe/London local 24h time (BST = UTC+1 in summer)", () => {
    // 14:30 UTC in June is 15:30 BST.
    expect(formatClockTime("2026-06-04T14:30:00Z")).toBe("15:30");
  });

  it("renders GMT (UTC+0) in winter", () => {
    expect(formatClockTime("2026-01-15T10:00:00Z")).toBe("10:00");
  });

  it("normalises midnight to 00:00 (not 24:00)", () => {
    // 23:00 UTC in June is 00:00 BST the next day.
    expect(formatClockTime("2026-06-04T23:00:00Z")).toBe("00:00");
  });

  it("returns an ASCII HH:mm pattern", () => {
    const result = formatClockTime("2026-06-04T14:30:00Z");
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  it("is deterministic for a fixed input regardless of host clock", () => {
    const a = formatClockTime("2026-06-04T14:30:00Z");
    const b = formatClockTime("2026-06-04T14:30:00Z");
    expect(a).toBe(b);
  });
});

describe("londonDayKey", () => {
  it("returns a sortable yyyy-MM-dd London-local day key", () => {
    expect(londonDayKey("2026-06-04T14:30:00Z")).toBe("2026-06-04");
  });

  it("rolls a late-night UTC time onto the next London day in summer", () => {
    // 23:30 UTC in June is 00:30 BST on the 5th.
    expect(londonDayKey("2026-06-04T23:30:00Z")).toBe("2026-06-05");
  });

  it("does not roll over in winter (GMT)", () => {
    expect(londonDayKey("2026-01-15T23:30:00Z")).toBe("2026-01-15");
  });
});

describe("formatDayDivider", () => {
  const NOW = new Date("2026-06-04T20:00:00Z"); // a Thursday evening, BST

  it("labels a message from the same London day as 'Today'", () => {
    expect(formatDayDivider("2026-06-04T09:00:00Z", NOW)).toBe("Today");
  });

  it("labels a message from the previous London day as 'Yesterday'", () => {
    expect(formatDayDivider("2026-06-03T09:00:00Z", NOW)).toBe("Yesterday");
  });

  it("labels older messages as a short 'EEE d MMM' date with no comma", () => {
    // 2026-06-04 is a Thursday.
    expect(formatDayDivider("2026-06-04T09:00:00Z", new Date("2026-06-10T12:00:00Z"))).toBe(
      "Thu 4 Jun"
    );
  });

  it("groups by London-local day, so a late-night UTC message counts as the next day", () => {
    // 23:30Z on the 3rd is 00:30 BST on the 4th, which is 'Today' relative to NOW.
    expect(formatDayDivider("2026-06-03T23:30:00Z", NOW)).toBe("Today");
  });

  it("returns ASCII-only labels", () => {
    expect(formatDayDivider("2026-06-04T09:00:00Z", new Date("2026-06-10T12:00:00Z"))).toMatch(
      /^[\x20-\x7E]+$/
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed-timestamp guard (hotfix, folded + pinned)
// ---------------------------------------------------------------------------
// blocks/parse.ts falls back to timestamp:"" on any header it cannot parse
// (e.g. a headerless first line). The formatters MUST tolerate that or a
// single bad block crashes the whole thread render (RangeError: Invalid time
// value). These pin the guard; the e2e in tmux-tab/thread tests the actual
// render path, which is the level the unit could not reach.
describe("malformed-timestamp tolerance (no throw, empty out)", () => {
  const bad = ["", "   ", "not-a-date", "14 open questions for the owner", "2026-13-45"];
  for (const value of bad) {
    it(`formatters return "" and never throw for ${JSON.stringify(value)}`, () => {
      expect(() => formatAbsolute(value)).not.toThrow();
      expect(() => formatRelative(value, FIXED_NOW)).not.toThrow();
      expect(() => formatClockTime(value)).not.toThrow();
      expect(() => londonDayKey(value)).not.toThrow();
      expect(() => formatDayDivider(value, FIXED_NOW)).not.toThrow();
      expect(formatAbsolute(value)).toBe("");
      expect(formatRelative(value, FIXED_NOW)).toBe("");
      expect(formatClockTime(value)).toBe("");
      expect(londonDayKey(value)).toBe("");
      expect(formatDayDivider(value, FIXED_NOW)).toBe("");
    });
  }
});

// ---------------------------------------------------------------------------
// dated card stamp (Cards tab has no day dividers to carry the date)
// ---------------------------------------------------------------------------
describe("formatCardStamp", () => {
  // A Friday lunchtime, BST. Every case injects this - never the wall clock.
  const NOW = new Date("2026-07-24T12:00:00Z");
  const H = 60 * 60 * 1000;

  it("stays relative well under 48h", () => {
    expect(formatCardStamp("2026-07-24T10:00:00Z", NOW)).toBe("about 2 hours ago");
    expect(formatCardStamp("2026-07-24T11:30:00Z", NOW)).toBe("30 minutes ago");
  });

  it("is still relative 1ms under the 48h boundary", () => {
    const iso = new Date(NOW.getTime() - 48 * H + 1).toISOString();
    expect(formatCardStamp(iso, NOW)).toBe("2 days ago");
  });

  it("switches to absolute AT exactly 48h (boundary is inclusive on the absolute side)", () => {
    // 2026-07-22T12:00:00Z is 13:00 BST.
    const iso = new Date(NOW.getTime() - 48 * H).toISOString();
    expect(formatCardStamp(iso, NOW)).toBe("22 Jul, 13:00");
  });

  it("renders an absolute London stamp well over 48h", () => {
    expect(formatCardStamp("2026-07-19T09:40:00Z", NOW)).toBe("19 Jul, 10:40");
  });

  it("pins the London timezone: a late-night UTC instant stamps the NEXT London day", () => {
    // 23:30Z on the 21st is 00:30 BST on the 22nd. A UTC-rendered stamp would
    // wrongly say "21 Jul, 23:30" and put the card on the wrong day.
    expect(formatCardStamp("2026-07-21T23:30:00Z", NOW)).toBe("22 Jul, 00:30");
  });

  it("renders GMT (no offset) in winter", () => {
    expect(formatCardStamp("2026-01-15T10:00:00Z", new Date("2026-01-20T12:00:00Z"))).toBe(
      "15 Jan, 10:00"
    );
  });

  it("keeps a future timestamp relative (negative age can never be stale)", () => {
    expect(formatCardStamp("2026-07-30T12:00:00Z", NOW)).toContain("in ");
  });

  it("returns an ASCII-only string", () => {
    expect(formatCardStamp("2026-07-19T09:40:00Z", NOW)).toMatch(/^[\x20-\x7E]+$/);
  });

  it('returns "" and never throws on unparseable input', () => {
    for (const bad of ["", "   ", "not-a-date", "2026-13-45"]) {
      expect(() => formatCardStamp(bad, NOW)).not.toThrow();
      expect(formatCardStamp(bad, NOW)).toBe("");
    }
  });

  it("is deterministic for a fixed (iso, now) pair", () => {
    const a = formatCardStamp("2026-07-19T09:40:00Z", NOW);
    const b = formatCardStamp("2026-07-19T09:40:00Z", NOW);
    expect(a).toBe(b);
  });

  // Timestamp.tsx builds its reference instant as `new Date(nowProp)`, so a
  // garbage `now` prop arrives as an Invalid Date. This branch fails SILENTLY
  // rather than throwing, which is why it gets its own pinned test: unguarded,
  // age is NaN, `NaN < CARD_STAMP_ABSOLUTE_AFTER_MS` is false, and the absolute
  // branch (which never reads now) wins by accident. A five-minute-old card
  // would render "25 Jul, 19:40" and look stale - the exact confusion
  // this formatter exists to kill, with no error anywhere to catch it.
  it("coalesces an Invalid Date now to the wall clock (relative branch, no throw)", () => {
    // Wall-clock relative for the same reason as the test below (the invalid
    // now is discarded, so the real clock is the reference). 5s back is
    // comfortably inside date-fns' "less than a minute" band, so the assertion
    // cannot flake on a slow run (the band is 30s wide).
    const recent = new Date(Date.now() - 5 * 1000).toISOString();
    expect(() => formatCardStamp(recent, new Date("nonsense"))).not.toThrow();
    expect(formatCardStamp(recent, new Date("nonsense"))).toBe("less than a minute ago");
  });

  it("renders a FRESH card relatively under an Invalid Date now, never as an absolute stamp", () => {
    // DELIBERATELY WALL-CLOCK RELATIVE - do NOT "tidy" this to a fixed literal
    // for consistency with its neighbours. This is the one test in the file
    // that exercises the path where `now` is THROWN AWAY, so the reference is
    // whatever the fallback picks up: the real clock. A hardcoded ISO would be
    // fresh only on the day it was written and would go red ~48h later, when
    // the absolute branch becomes the correct answer, for a reason that looks
    // nothing like the cause. Derive it at run time so "fresh" stays fresh.
    //
    // The dangerous shape, asserted on ABSENCE so a regression back to the NaN
    // path fails loudly instead of quietly producing a plausible-looking date.
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const out = formatCardStamp(fresh, new Date("nonsense"));
    expect(out).toBe("5 minutes ago");
    expect(out).not.toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  });

  it("still resolves a genuinely old card to absolute under an Invalid Date now", () => {
    // Coalescing must not break the 48h semantics, just re-base them.
    expect(formatCardStamp("2020-03-05T14:40:00Z", new Date("nonsense"))).toBe("5 Mar, 14:40");
  });
});

describe("formatCardTooltip", () => {
  const NOW = new Date("2026-07-24T12:00:00Z");

  it("carries the full absolute London timestamp plus the relative age", () => {
    expect(formatCardTooltip("2026-07-19T09:40:00Z", NOW)).toBe("19 Jul 2026, 10:40 (5 days ago)");
  });

  it("includes the year the visible stamp omits", () => {
    expect(formatCardTooltip("2026-07-19T09:40:00Z", NOW)).toContain("2026");
  });

  it("is London-local, not UTC", () => {
    expect(formatCardTooltip("2026-07-21T23:30:00Z", NOW)).toContain("22 Jul 2026, 00:30");
  });

  it('returns "" and never throws on unparseable input', () => {
    for (const bad of ["", "not-a-date"]) {
      expect(() => formatCardTooltip(bad, NOW)).not.toThrow();
      expect(formatCardTooltip(bad, NOW)).toBe("");
    }
  });

  // The crash shape: an Invalid Date reference reaching date-fns raises
  // "RangeError: Invalid time value" and kills the whole page render.
  it("does not throw when now is an Invalid Date, and still renders the absolute half", () => {
    expect(() => formatCardTooltip("2026-07-19T09:40:00Z", new Date("nonsense"))).not.toThrow();
    const out = formatCardTooltip("2026-07-19T09:40:00Z", new Date("nonsense"));
    expect(out).toContain("19 Jul 2026, 10:40 (");
    expect(out).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe("resolveNow (MC_NOW guard, 2026-06-11 lifeline hardening)", () => {
  it("parses a valid MC_NOW value", () => {
    const d = resolveNow("2026-06-10T12:00:00Z");
    expect(d.toISOString()).toBe("2026-06-10T12:00:00.000Z");
  });

  it("falls back to wall clock when MC_NOW is unset", () => {
    const before = Date.now();
    const d = resolveNow(undefined);
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it("falls back to wall clock (never Invalid Date) on garbage MC_NOW", () => {
    const d = resolveNow("not-a-date");
    expect(Number.isNaN(d.getTime())).toBe(false);
    // The crash shape: this must not throw.
    expect(() => d.toISOString()).not.toThrow();
  });

  it("falls back on empty string", () => {
    const d = resolveNow("");
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});
