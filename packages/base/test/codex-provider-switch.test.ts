import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("codex-provider-switch", () => {
  it("runs python provider switch test suite", () => {
    const script = path.join(PACKAGE_ROOT, "test", "codex-provider-switch.test.py");
    const result = spawnSync("python3", [script], {
      encoding: "utf8",
      cwd: PACKAGE_ROOT,
      timeout: 60_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
