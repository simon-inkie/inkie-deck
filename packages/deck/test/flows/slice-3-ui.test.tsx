// @vitest-environment jsdom
/**
 * slice-3-ui.test.tsx - UI, API route, and SSR tests for Deck Flows Slice 3 Pass B.
 *
 * Covers:
 * - GET /api/flows?view=library returning built-in ticket-to-pr without host paths
 * - requireSameOriginWrite 403 rejection on cross-origin POST /api/flows
 * - 405 Allow: GET, POST on DELETE /api/flows
 * - Same-origin POST intent=plan -> start before approval (409) -> approve wrong hash (409)
 *   -> approve exact hash (200, flow_approved in SQLite) -> duplicate approve (409) -> start (200)
 * - Draft plan returning diffFromTemplate + invalid YAML 400 without disk write
 * - SSR & jsdom render of /flows showing Launch panel, Approve Flow button, Start Run button,
 *   live draft diff preview, and zero private_details / host path leakage.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowCardStream } from "../../app/components/FlowCardStream.js";
import { FlowLaunchPanel, FlowRunApprovalBar } from "../../app/components/FlowLaunchPanel.js";
import type { FlowCardStreamView, FlowLaunchCatalog } from "../../app/lib/flows/card-stream.js";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { acquireOwnerLock } from "../../app/lib/flows/owner.server.js";
import { openFlowsStore } from "../../app/lib/flows/store.server.js";
import type { FlowEvent } from "../../app/lib/flows/types.js";
import {
  approveFlowFromUi,
  FlowNotApprovedError,
  listFlowLaunchCatalog,
  planFlowFromUi,
  startFlowFromUi,
} from "../../app/lib/flows/ui-actions.server.js";
import { action as apiFlowsAction, loader as apiFlowsLoader } from "../../app/routes/api.flows.js";
import FlowsRoute, { loader as flowsRouteLoader } from "../../app/routes/flows.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function callApiLoader(urlStr: string, init?: RequestInit) {
  const url = new URL(urlStr);
  return apiFlowsLoader({
    request: new Request(url, init),
    url,
    params: {},
    context: {},
    pattern: "/api/flows",
  });
}

function callApiAction(urlStr: string, init: RequestInit) {
  const url = new URL(urlStr);
  return apiFlowsAction({
    request: new Request(url, init),
    url,
    params: {},
    context: {},
    pattern: "/api/flows",
  });
}

function callFlowsRouteLoader(urlStr: string) {
  const url = new URL(urlStr);
  return flowsRouteLoader({
    request: new Request(url),
    url,
    params: {},
    context: {},
    pattern: "/flows",
  });
}

function sameOriginHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    host: "localhost",
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function postFlowAction(body: Record<string, string>) {
  return callApiAction("http://localhost/api/flows", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

describe("Deck Flows Slice 3 Pass B - UI, Launch Catalog & Same-Origin Actions", () => {
  let scratchDir: string;
  let dataRoot: string;
  let projectRoot: string;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-ui-"));
    dataRoot = path.join(scratchDir, "data");
    projectRoot = path.join(scratchDir, "project");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    vi.stubEnv("DATA_ROOT", dataRoot);
    vi.stubEnv("FLOWS_PROJECT_ROOT", projectRoot);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("GET /api/flows?view=library returns built-in ticket-to-pr without host path leakage", async () => {
    const res = await callApiLoader("http://localhost/api/flows?view=library");
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(scratchDir);
    expect(bodyText).not.toContain("private_details");

    const parsed = JSON.parse(bodyText) as {
      ok: boolean;
      catalog: FlowLaunchCatalog;
    };
    expect(parsed.ok).toBe(true);
    const ticketFlow = parsed.catalog.flows.find((f) => f.flowRef === "ticket-to-pr");
    expect(ticketFlow).toBeDefined();
    expect(ticketFlow?.source).toBe("builtin");
    expect(ticketFlow?.yaml).toContain("flow: ticket-to-pr");
    expect(ticketFlow?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("plans and reads runs with the dev Flows root and a checkout-local Deck data root", async () => {
    vi.stubEnv("DATA_ROOT", path.join(process.cwd(), ".runtime", "data"));
    vi.stubEnv("FLOWS_DATA_ROOT", dataRoot);
    const projectId = "proj-dev";
    const runId = "run-dev";
    const plan = await postFlowAction({ intent: "plan", projectId, runId, flowRef: "ticket-to-pr" });
    expect(plan.status).toBe(200);
    const runs = await callApiLoader(`http://localhost/api/flows?project=${projectId}`);
    await expect(runs.json()).resolves.toMatchObject({ runs: [{ runId, status: "planned" }] });
  });

  it("enforces requireSameOriginWrite (403) and method checks (405 Allow: GET, POST)", async () => {
    // Cross-origin POST rejected with 403
    try {
      await callApiAction("http://localhost/api/flows", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          intent: "plan",
          projectId: "proj-1",
          runId: "run-1",
          flowRef: "ticket-to-pr",
        }),
      });
      expect.unreachable("Expected 403 Response");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
    }

    // DELETE in action -> 405 Allow: GET, POST
    const delActionRes = await callApiAction("http://localhost/api/flows", {
      method: "DELETE",
      headers: sameOriginHeaders(),
    });
    expect(delActionRes.status).toBe(405);
    expect(delActionRes.headers.get("Allow")).toBe("GET, POST");

    // DELETE in loader -> 405 Allow: GET, POST
    const delLoaderRes = await callApiLoader("http://localhost/api/flows", {
      method: "DELETE",
    });
    expect(delLoaderRes.status).toBe(405);
    expect(delLoaderRes.headers.get("Allow")).toBe("GET, POST");
  });

  it("runs full plan -> 409 unapproved start -> 409 wrong hash -> 200 approve -> 409 duplicate -> 200 start via POST /api/flows", async () => {
    const projectId = "proj-ui-gate";
    const runId = "run-ui-gate-1";

    // Missing run start -> 404
    const missingStart = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ intent: "start", projectId, runId: "nonexistent" }),
    });
    expect(missingStart.status).toBe(404);

    // 1. Plan run (remains planned, not approved)
    const planRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        intent: "plan",
        projectId,
        runId,
        flowRef: "ticket-to-pr",
      }),
    });
    expect(planRes.status).toBe(200);
    const planJson = (await planRes.json()) as {
      ok: boolean;
      runId: string;
      flowRef: string;
      flowHash: string;
      status: string;
      expectedDecisions: string[];
    };
    expect(planJson.ok).toBe(true);
    expect(planJson.status).toBe("planned");
    expect(planJson.flowRef).toBe("ticket-to-pr");
    expect(planJson.flowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(planJson.expectedDecisions).toContain("intake");
    expect(planJson.expectedDecisions).toContain("ready");

    // 2. Attempt start BEFORE approval -> HTTP 409
    const unapprovedStartRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ intent: "start", projectId, runId }),
    });
    expect(unapprovedStartRes.status).toBe(409);

    // Direct ui-actions check throws typed FlowNotApprovedError
    await expect(startFlowFromUi({ projectId, runId, dataRoot })).rejects.toBeInstanceOf(
      FlowNotApprovedError,
    );

    // 3. Approve with WRONG hash -> HTTP 409
    const wrongApproveRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        intent: "approve",
        projectId,
        runId,
        flowHash: "0".repeat(64),
      }),
    });
    expect(wrongApproveRes.status).toBe(409);

    // 4. Approve with EXACT hash -> HTTP 200 and records flow_approved in SQLite
    const approveRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        intent: "approve",
        projectId,
        runId,
        flowHash: planJson.flowHash,
      }),
    });
    expect(approveRes.status).toBe(200);
    const approveJson = (await approveRes.json()) as {
      ok: boolean;
      status: string;
      flowHash: string;
      actorId: string;
    };
    expect(approveJson).toMatchObject({
      ok: true,
      status: "approved",
      flowHash: planJson.flowHash,
      actorId: "operator-1",
    });

    const loadedApproved = loadRunState(projectId, runId, { dataRoot });
    expect(loadedApproved.state.status).toBe("approved");
    expect(loadedApproved.events.some((e) => e.type === "flow_approved")).toBe(true);

    // 5. Duplicate approval -> HTTP 409
    const dupApproveRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        intent: "approve",
        projectId,
        runId,
        flowHash: planJson.flowHash,
      }),
    });
    expect(dupApproveRes.status).toBe(409);

    // 6. Start approved run -> HTTP 200 and advances ticket-to-pr to intake waiting_decision
    const startRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ intent: "start", projectId, runId }),
    });
    expect(startRes.status).toBe(200);
    const startJson = (await startRes.json()) as {
      ok: boolean;
      finalStatus: string;
      runId: string;
    };
    expect(startJson.ok).toBe(true);
    expect(startJson.finalStatus).toBe("waiting_decision");
  }, 15_000);

  it("plans a custom draft via POST form/JSON returning diffFromTemplate and rejects invalid YAML with 400", async () => {
    const projectId = "proj-ui-draft";
    const runId = "run-ui-draft-1";

    // Invalid YAML returns 400 without writing any draft file
    const badRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        intent: "plan",
        projectId,
        runId: "bad-run",
        draftName: "bad-draft",
        draftYaml: "flow: bad-draft\nversion: 2\nsteps: []\n",
      }),
    });
    expect(badRes.status).toBe(400);
    expect(
      fs.existsSync(path.join(projectRoot, ".deck", "flows", "drafts", "bad-draft.yaml")),
    ).toBe(false);

    const catalog = listFlowLaunchCatalog();
    const baseFlow = catalog.flows.find((f) => f.flowRef === "ticket-to-pr")!;
    const draftYaml = baseFlow.yaml.replace("title: Ticket to PR", "title: Custom UI Draft Flow");

    // Submit via FormData to verify form-data path too
    const form = new FormData();
    form.set("intent", "plan");
    form.set("projectId", projectId);
    form.set("runId", runId);
    form.set("draftName", "custom-ui-draft");
    form.set("baseTemplateRef", "ticket-to-pr");
    form.set("draftYaml", draftYaml);

    const okRes = await callApiAction("http://localhost/api/flows", {
      method: "POST",
      headers: sameOriginHeaders(),
      body: form,
    });
    expect(okRes.status).toBe(200);
    const okText = await okRes.text();
    expect(okText).not.toContain(scratchDir);

    const okJson = JSON.parse(okText) as {
      ok: boolean;
      runId: string;
      status: string;
      diffFromTemplate?: string;
    };
    expect(okJson.ok).toBe(true);
    expect(okJson.status).toBe("planned");
    expect(okJson.diffFromTemplate).toContain("--- builtin/ticket-to-pr.yaml");
    expect(okJson.diffFromTemplate).toContain("+++ drafts/custom-ui-draft.yaml");
    expect(okJson.diffFromTemplate).toContain("-title: Ticket to PR");
    expect(okJson.diffFromTemplate).toContain("+title: Custom UI Draft Flow");

    // Draft also appears in catalog listing
    const updatedCatalog = listFlowLaunchCatalog();
    const listedDraft = updatedCatalog.drafts.find((d) => d.draftName === "custom-ui-draft");
    expect(listedDraft).toBeDefined();
    expect(listedDraft?.source).toBe("draft");
    expect(listedDraft?.diffFromTemplate).toContain("+title: Custom UI Draft Flow");

    const draftFile = path.join(projectRoot, ".deck", "flows", "drafts", "custom-ui-draft.yaml");
    const originalBytes = fs.readFileSync(draftFile);
    const replacement = draftYaml.replace("Custom UI Draft Flow", "Replacement Draft");
    const duplicate = await postFlowAction({
      intent: "plan", projectId, runId, draftName: "custom-ui-draft", draftYaml: replacement,
    });
    expect(duplicate.status).toBe(409);
    expect(fs.readFileSync(draftFile)).toEqual(originalBytes);
  });

  it.each([
    {
      name: "shows the missing runtime guidance after Start work",
      expired: false,
      actor: "human",
      choiceKey: "start",
      resolution: "answered",
      terminalReason: "runtime_adapter_missing",
      message: "No runtime adapter is configured. Live runtimes arrive in slice 3b. For fixture mode, run pnpm -C packages/deck exec vitest run test/flows/slice-3-e2e.test.ts.",
    },
    {
      name: "settles expired intake from its card without starting build",
      expired: true,
      actor: "system",
      choiceKey: "unanswered_expired",
      resolution: "expired",
      terminalReason: "unanswered_expired",
      message: "The decision expired. The run has stopped.",
    },
  ])("$name", async ({ expired, actor, choiceKey, resolution, terminalReason, message }) => {
    vi.unstubAllGlobals();
    const projectId = "proj-intake";
    const runId = "run-intake";
    const planned = planFlowFromUi({ projectId, runId, flowRef: "ticket-to-pr" });
    approveFlowFromUi({ projectId, runId, flowHash: planned.flowHash });
    expect((await postFlowAction({ intent: "start", projectId, runId })).status).toBe(200);
    const run = await callApiLoader(`http://localhost/api/flows?project=${projectId}&run=${runId}`);
    const { stream } = await run.json() as { stream: FlowCardStreamView };
    const handoffId = stream.activeDecision?.handoffId;
    expect(handoffId).toBeDefined();
    expect((await postFlowAction({
      intent: "decide", projectId, runId, handoffId: handoffId!, choiceKey: "invalid",
    })).status).toBe(409);
    if (expired) {
      const expiresAt = loadRunState(projectId, runId).state.activeHandoff?.expiresAt;
      expect(expiresAt).toBeDefined();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(expiresAt!));
    }

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      postFlowAction(JSON.parse(String(init?.body))),
    );
    act(() => root.render(<FlowCardStream stream={stream} />));
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Start work");
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await fetchMock.mock.results[0]?.value;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="flow-card-decision"]')).toBeNull();
    expect(container.querySelector('[data-testid="flow-run-status"]')?.textContent).toBe("stopped");
    expect(container.textContent).toContain(message);
    const { events, state } = loadRunState(projectId, runId);
    expect(state.terminalReason).toBe(terminalReason);
    expect(events.filter((event) => event.type === "handoff_returned")).toEqual([
      expect.objectContaining({
        actor, stepId: "intake", data: expect.objectContaining({ choiceKey, resolution }),
      }),
    ]);
    expect(events.some((event) => event.type === "step_started" && event.stepId === "build")).toBe(!expired);
    expect((await postFlowAction({
      intent: "decide", projectId, runId, handoffId: handoffId!, choiceKey: "stop",
    })).status).toBe(409);
  }, 15_000);

  it("plans a standalone draft and leaves it intact when switching the editor to a template", async () => {
    vi.unstubAllGlobals();
    const projectId = "proj-standalone";
    const base = listFlowLaunchCatalog().flows.find((flow) => flow.flowRef === "ticket-to-pr")!;
    const draftYaml = base.yaml.replace("flow: ticket-to-pr", "flow: new-flow");
    // The draft's filename also matches the template's implicit draft name.
    const draftName = base.flowRef;
    expect((await postFlowAction({
      intent: "plan", projectId, runId: "initial-draft", draftName, draftYaml,
    })).status).toBe(200);
    const catalog = listFlowLaunchCatalog();
    const responses: Response[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const response = await postFlowAction(JSON.parse(String(init?.body)));
      responses.push(response.clone());
      return response;
    });
    const LaunchStub = createRoutesStub([{
      path: "/flows",
      Component: () => <FlowLaunchPanel catalog={catalog} selectedProject={projectId} />,
    }]);
    act(() => root.render(<LaunchStub initialEntries={["/flows"]} />));
    const selection = container.querySelector<HTMLSelectElement>('[data-testid="launch-flow-select"]')!;
    const changeSelection = (value: string) => act(() => {
      selection.value = value;
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const submit = () => act(async () => {
      selection.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    changeSelection(`draft:${draftName}`);
    await submit();
    expect(responses[0]?.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("baseTemplateRef");
    await expect(responses[0]!.json()).resolves.toMatchObject({ flowRef: "new-flow" });

    changeSelection(`flow:${base.flowRef}`);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="launch-draft-toggle"]')!.click());
    expect(container.querySelector<HTMLInputElement>('[data-testid="launch-draft-name"]')?.value).toBe("");
    await submit();
    expect(responses[1]?.status).toBe(200);
    expect(fs.readFileSync(path.join(projectRoot, ".deck", "flows", "drafts", `${draftName}.yaml`), "utf8"))
      .toBe(draftYaml);
  });

  it("renders Launch panel, Approve Flow button on planned runs, Start Run button on approved runs, and leaks zero private_details", async () => {
    const projectId = "proj-ssr-render";
    const plannedRunId = "run-ssr-planned";
    const approvedRunId = "run-ssr-approved";
    const PRIVATE_SECRET = "PRIVATE_CUSTOMER_TOKEN_DO_NOT_LEAK_7788";

    const planned = planFlowFromUi({
      projectId,
      runId: plannedRunId,
      flowRef: "ticket-to-pr",
      dataRoot,
    });

    const approvedPlan = planFlowFromUi({
      projectId,
      runId: approvedRunId,
      flowRef: "ticket-to-pr",
      dataRoot,
    });
    approveFlowFromUi({
      projectId,
      runId: approvedRunId,
      flowHash: approvedPlan.flowHash,
      actorId: "operator-1",
      dataRoot,
    });

    // Attach a private detail row on an unrelated run to verify private_details never surfaces
    const secretRunId = "run-ssr-secret";
    const lock = acquireOwnerLock(projectId, dataRoot);
    const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
    try {
      store.createAndApproveRun({
        runId: secretRunId,
        flowRef: "ticket-to-pr",
        flowHash: planned.flowHash,
        flowYamlBytes: listFlowLaunchCatalog().flows.find((f) => f.flowRef === "ticket-to-pr")!
          .yaml,
        source: "builtin",
        expectedDecisions: [],
        actorId: "operator-1",
      });
      const rows = store.getEvents(secretRunId);
      const last = rows[rows.length - 1]!;
      const runStartEv: FlowEvent = {
        v: 1,
        runId: secretRunId,
        seq: last.seq + 1,
        eventId: "ev_priv_check",
        prev: last.hash,
        at: new Date().toISOString(),
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 200000, steps: 25 },
        },
      };
      store.appendEvent(runStartEv, { privateDetail: PRIVATE_SECRET });
    } finally {
      store.close();
      lock.release();
    }

    // 1. SSR render of planned run
    const plannedLoaderData = (await callFlowsRouteLoader(
      `http://localhost/flows?project=${projectId}&run=${plannedRunId}`,
    )) as {
      stream: FlowCardStreamView;
      catalog: FlowLaunchCatalog;
    };
    const PlannedStub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={plannedLoaderData as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    const plannedHtml = renderToStaticMarkup(
      <PlannedStub initialEntries={[`/flows?project=${projectId}&run=${plannedRunId}`]} />,
    );
    expect(plannedHtml).toContain('data-testid="flow-launch-panel"');
    expect(plannedHtml).toContain("ticket-to-pr");
    expect(plannedHtml).toContain('data-testid="flow-approve-button"');
    expect(plannedHtml).toContain("Approve Flow");
    expect(plannedHtml).toContain(planned.flowHash.slice(0, 12));
    expect(plannedHtml).not.toContain('data-testid="flow-start-button"');
    expect(plannedHtml).not.toContain(PRIVATE_SECRET);
    expect(plannedHtml).not.toContain(scratchDir);
    expect(plannedHtml).not.toContain("private_details");

    // 2. SSR render of approved run
    const approvedLoaderData = (await callFlowsRouteLoader(
      `http://localhost/flows?project=${projectId}&run=${approvedRunId}`,
    )) as {
      stream: FlowCardStreamView;
      catalog: FlowLaunchCatalog;
    };
    const ApprovedStub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={approvedLoaderData as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    const approvedHtml = renderToStaticMarkup(
      <ApprovedStub initialEntries={[`/flows?project=${projectId}&run=${approvedRunId}`]} />,
    );
    expect(approvedHtml).toContain('data-testid="flow-launch-panel"');
    expect(approvedHtml).toContain('data-testid="flow-start-button"');
    expect(approvedHtml).toContain("Start Run");
    expect(approvedHtml).not.toContain('data-testid="flow-approve-button"');
    expect(approvedHtml).not.toContain(PRIVATE_SECRET);
    expect(approvedHtml).not.toContain(scratchDir);

    // 3. Interactive jsdom test: toggle Draft custom YAML, edit YAML -> live unified diff appears;
    //    click Approve Flow and Start Run -> posts exact intent and hash.
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { intent?: string };
      if (body.intent === "approve") {
        return new Response(JSON.stringify({ ok: true, status: "approved" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, finalStatus: "waiting_decision" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const InteractiveStub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <div>
            <FlowLaunchPanel catalog={plannedLoaderData.catalog} selectedProject={projectId} />
            <FlowRunApprovalBar
              stream={plannedLoaderData.stream}
              catalog={plannedLoaderData.catalog}
            />
          </div>
        ),
      },
    ]);
    act(() => {
      root.render(
        <InteractiveStub initialEntries={[`/flows?project=${projectId}&run=${plannedRunId}`]} />,
      );
    });

    const draftToggle = container.querySelector(
      '[data-testid="launch-draft-toggle"]',
    ) as HTMLButtonElement;
    expect(draftToggle).not.toBeNull();
    act(() => {
      draftToggle.click();
    });

    const yamlTextarea = container.querySelector(
      '[data-testid="launch-draft-yaml"]',
    ) as HTMLTextAreaElement;
    expect(yamlTextarea).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(
        yamlTextarea,
        yamlTextarea.value.replace("title: Ticket to PR", "title: Interactive Draft"),
      );
      yamlTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      yamlTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const diffPreview = container.querySelector('[data-testid="launch-diff-preview"]');
    expect(diffPreview?.textContent).toContain("-title: Ticket to PR");
    expect(diffPreview?.textContent).toContain("+title: Interactive Draft");

    // Click Approve Flow on planned run
    const approveBtn = container.querySelector(
      '[data-testid="flow-approve-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const approveCallBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      intent: string;
      projectId: string;
      runId: string;
      flowHash: string;
    };
    expect(approveCallBody).toEqual({
      intent: "approve",
      projectId,
      runId: plannedRunId,
      flowHash: planned.flowHash,
    });
  });

  it("R1-7: GET /api/flows?view=library and /flows loader still return ticket-to-pr when a broken yaml exists", async () => {
    const projFlowsDir = path.join(projectRoot, ".deck", "flows");
    const draftsDir = path.join(projFlowsDir, "drafts");
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(path.join(projFlowsDir, "broken-proj.yaml"), "flow: [broken\n", "utf8");
    fs.writeFileSync(path.join(projFlowsDir, "ticket-to-pr.yaml"), "flow: [broken\n", "utf8");
    fs.writeFileSync(path.join(draftsDir, "broken-draft.yaml"), "flow: bad\nversion: 2\n", "utf8");

    const apiRes = await callApiLoader("http://localhost/api/flows?view=library");
    expect(apiRes.status).toBe(200);
    const apiJson = (await apiRes.json()) as { ok: boolean; catalog: FlowLaunchCatalog };
    expect(apiJson.ok).toBe(true);
    expect(apiJson.catalog.flows).toContainEqual(expect.objectContaining({
      flowRef: "ticket-to-pr", source: "builtin",
    }));
    expect((await postFlowAction({
      intent: "plan", projectId: "proj-fallback", runId: "run-fallback", flowRef: "ticket-to-pr",
    })).status).toBe(200);

    const routeData = (await callFlowsRouteLoader("http://localhost/flows")) as {
      catalog: FlowLaunchCatalog;
    };
    expect(routeData.catalog.flows.some((f) => f.flowRef === "ticket-to-pr")).toBe(true);
  });

  it("R2-1: /flows loader returns HTTP 422 with sanitised message and zero host paths when .deck/flows has a symlink", async () => {
    const projFlowsDir = path.join(projectRoot, ".deck", "flows");
    fs.mkdirSync(projFlowsDir, { recursive: true });
    const outside = path.join(scratchDir, "outside-ui.yaml");
    fs.writeFileSync(outside, "flow: x\nversion: 1\nsteps: []\n", "utf8");
    fs.symlinkSync(outside, path.join(projFlowsDir, "evil-link.yaml"));

    const routeResult = (await callFlowsRouteLoader("http://localhost/flows")) as {
      init: { status: number } | null;
      data: { error: string | null; catalog: FlowLaunchCatalog };
    };
    expect(routeResult.init?.status).toBe(422);
    expect(routeResult.data.error).toBe("Flow library failed safety verification.");
    expect(routeResult.data.catalog).toEqual({ flows: [], drafts: [] });

    const serialized = JSON.stringify(routeResult);
    expect(serialized).not.toContain(scratchDir);
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain("/var/tmp");

    const ErrorStub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={routeResult.data as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    const html = renderToStaticMarkup(<ErrorStub initialEntries={["/flows"]} />);
    expect(html).toContain("Flow library failed safety verification.");
    expect(html).not.toContain(scratchDir);
    expect(html).not.toContain(projectRoot);
    expect(html).not.toContain("/var/tmp");
  });
});
