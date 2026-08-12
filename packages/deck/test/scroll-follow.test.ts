/**
 * scroll-follow.test.ts - unit truth table for TASK-454's follow logic.
 *
 * The 455 scroll pin as a test: follow-bottom must distinguish user-at-bottom
 * from user-scrolled-up before it may move the viewport.
 *
 * ASCII only (FND-05).
 */
import { describe, expect, it } from "vitest";
import {
  isNearBottom,
  shouldFollow,
  NEAR_BOTTOM_THRESHOLD_PX,
} from "../app/lib/scroll-follow";

describe("shouldFollow truth table", () => {
  it("initial load with no hash follows to latest", () => {
    expect(
      shouldFollow({ isInitial: true, hasHash: false, wasNearBottom: false })
    ).toBe(true);
  });

  it("initial load with a deep-link hash does NOT follow (deep-link owns scroll)", () => {
    expect(
      shouldFollow({ isInitial: true, hasHash: true, wasNearBottom: false })
    ).toBe(false);
  });

  it("new content while user near bottom follows", () => {
    expect(
      shouldFollow({ isInitial: false, hasHash: false, wasNearBottom: true })
    ).toBe(true);
  });

  it("new content while user scrolled up NEVER moves the viewport (455 pin)", () => {
    expect(
      shouldFollow({ isInitial: false, hasHash: false, wasNearBottom: false })
    ).toBe(false);
    // Hash present changes nothing on updates - still gated on position.
    expect(
      shouldFollow({ isInitial: false, hasHash: true, wasNearBottom: false })
    ).toBe(false);
  });
});

describe("isNearBottom", () => {
  it("true at exact bottom", () => {
    // 1000 total, viewport 400, scrolled to 600 -> distance 0.
    expect(isNearBottom(600, 1000, 400)).toBe(true);
  });

  it("true within the threshold", () => {
    expect(isNearBottom(600 - NEAR_BOTTOM_THRESHOLD_PX, 1000, 400)).toBe(true);
  });

  it("false beyond the threshold", () => {
    expect(isNearBottom(600 - NEAR_BOTTOM_THRESHOLD_PX - 1, 1000, 400)).toBe(false);
  });

  it("true when content fits the viewport (nothing to scroll)", () => {
    expect(isNearBottom(0, 300, 400)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isNearBottom(500, 1000, 400, 100)).toBe(true);
    expect(isNearBottom(499, 1000, 400, 100)).toBe(false);
  });
});
