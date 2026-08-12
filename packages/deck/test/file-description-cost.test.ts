/**
 * file-description-cost.test.ts - the gemini spend cost-calc (computeCostUsd).
 *
 * The cost-per-call formula is the cost-control mechanism, so the math is
 * pinned here. Pure - no fs, no gemini call.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import { computeCostUsd } from "~/lib/file-description.server.js";

describe("computeCostUsd", () => {
  it("is zero for zero tokens", () => {
    expect(computeCostUsd(0, 0)).toBe(0);
  });

  it("computes default flash-lite cost (input $0.10/Mtok, output $0.40/Mtok)", () => {
    // 1,000,000 input tokens => $0.10; 1,000,000 output => $0.40.
    expect(computeCostUsd(1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(computeCostUsd(0, 1_000_000)).toBeCloseTo(0.4, 10);
    expect(computeCostUsd(1_000_000, 1_000_000)).toBeCloseTo(0.5, 10);
  });

  it("a realistic small call is well under a cent", () => {
    // ~400 prompt + ~60 completion tokens.
    const cost = computeCostUsd(400, 60);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it("honours custom per-Mtok rates", () => {
    // input $1/Mtok, output $2/Mtok.
    expect(computeCostUsd(1_000_000, 1_000_000, 1, 2)).toBeCloseTo(3, 10);
    expect(computeCostUsd(500_000, 250_000, 2, 4)).toBeCloseTo(2, 10);
  });

  it("scales linearly with token count", () => {
    const single = computeCostUsd(1000, 500);
    const double = computeCostUsd(2000, 1000);
    expect(double).toBeCloseTo(single * 2, 12);
  });
});
