import { describe, it, expect } from "vitest";
import { statSync } from "node:fs";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

describe("scaffold smoke tests", () => {
  it("MC_SANDBOX_ONLY is set by test/setup.ts", () => {
    expect(process.env["MC_SANDBOX_ONLY"]).toBe("1");
  });

  it("~/* alias resolves via vite-tsconfig-paths", () => {
    // If the import at the top of this file succeeded, the alias is working.
    expect(typeof mkdtempSync).toBe("function");
    expect(typeof rmSync).toBe("function");
  });

  it("mkdtempSync creates an isolated directory", () => {
    const dir = mkdtempSync();
    try {
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(dir);
    }
  });
});
