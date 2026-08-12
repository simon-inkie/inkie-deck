/**
 * Vitest global setup file.
 * Configures the sandbox-only guard and exports mkdtemp helpers for all test suites.
 */

// Enforce sandbox-only mode in all tests.
// This ensures assertSafeWritePath() always applies the full guard.
process.env["MC_SANDBOX_ONLY"] = "1";

// Re-export helpers for test files that import from test/setup.ts directly.
export { mkdtempSync, rmSync } from "../app/lib/test-helpers.js";
