// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { openFlowsStore } from "../../app/lib/flows/store.server.js";
import { action as apiFlowsAction } from "../../app/routes/api.flows.js";
import FlowsRoute, { loader as flowsRouteLoader } from "../../app/routes/flows.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "planning-project";
const runId = "planning-run";
const selectedRun = `/flows?project=${projectId}&run=${runId}`;
const flowYaml = `flow: planning-fixture
version: 1
limits:
  max_attempts: 1
steps:
  - id: release
    type: decision
    title: Release draft
    options:
      - key: ship
        label: Ship draft
        end: done
      - key: stop
        label: Keep draft
        end: stopped
  - id: scan
    type: agent
    title: Check protected paths
    outputs: [draft]
    rules:
      - protected_path_touched: decide
  - id: verify
    type: check
    title: Verify at attempt limit
    against: draft
    run: [check_nonempty]
`;

function post(body: Record<string, string>, origin = "http://localhost") {
  const url = new URL("http://localhost/api/flows");
  return apiFlowsAction({
    request: new Request(url, {
      method: "POST",
      headers: { host: "localhost", origin, "content-type": "application/json" },
      body: JSON.stringify({ projectId, runId, ...body }),
    }),
    url,
    params: {},
    context: {},
    pattern: "/api/flows",
  });
}

describe("planning pre-answer controls", () => {
  let scratch: string;
  let dataRoot: string;
  let projectRoot: string;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-preanswer-ui-"));
    dataRoot = path.join(scratch, "data");
    projectRoot = path.join(scratch, "checkout");
    fs.mkdirSync(projectRoot);
    vi.stubEnv("DATA_ROOT", dataRoot);
    vi.stubEnv("FLOWS_DATA_ROOT", dataRoot);
    vi.stubEnv("FLOWS_PROJECT_ROOT", projectRoot);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { force: true, recursive: true });
  });

  async function plan() {
    const response = await post({ intent: "plan", draftYaml: flowYaml });
    expect(response.status).toBe(200);
    return await response.json() as { flowHash: string; expectedDecisions: string[] };
  }

  function readEvents() {
    return loadRunState(projectId, runId).events;
  }

  function renderRun() {
    const Routes = createRoutesStub([{
      path: "/flows",
      loader: ({ request, params, context }) => flowsRouteLoader({
        request, params, context, url: new URL(request.url), pattern: "/flows",
      }),
      Component: () => (
        <FlowsRoute
          loaderData={useLoaderData<typeof flowsRouteLoader>()}
          params={{}}
          matches={[] as never}
        />
      ),
    }]);
    return act(async () => root.render(<Routes initialEntries={[selectedRun]} />));
  }

  it("offers pinned choices, persists the replacement and shows the applied answer after reload", async () => {
    const { expectedDecisions } = await plan();
    expect(expectedDecisions).toEqual(["release", "scan", "verify"]);
    await renderRun();
    const planningCard = () => container.querySelector('[data-testid="flow-card-planning"]')!;
    expect(planningCard().textContent).toContain("Release draft");
    expect(planningCard().textContent).toContain("Check protected paths");
    expect(planningCard().textContent).toContain("Verify at attempt limit");
    expect(container.querySelector('select[name="choiceKey"]')).toBeNull();

    let finishSave: (() => void) | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.intent === "preanswer" && body.choiceKey === "ship") {
        await new Promise<void>((resolve) => { finishSave = resolve; });
      }
      return post(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flow-approve-button"]')!.click());

    const releaseChoice = () => Array.from(container.querySelectorAll<HTMLSelectElement>('select[name="choiceKey"]'))
      .find((select) => select.labels?.[0]?.textContent?.startsWith("Release draft"))!;
    expect(Array.from(releaseChoice().options).filter((option) => option.value).map((option) => option.text)).toEqual([
      "Ship draft", "Keep draft",
    ]);
    const submitChoice = (choice: string) => {
      const select = releaseChoice();
      select.value = choice;
      select.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };

    await act(async () => submitChoice("stop"));
    expect(planningCard().textContent).toContain("Saved pre-answer: Keep draft");

    await act(async () => submitChoice("ship"));
    const startButton = () => container.querySelector<HTMLButtonElement>('[data-testid="flow-start-button"]')!;
    expect(startButton().disabled).toBe(true);
    expect(readEvents().at(-1)).toMatchObject({ type: "preanswer_given", data: { choiceKey: "stop" } });
    await act(async () => finishSave!());

    act(() => root.unmount());
    root = createRoot(container);
    await renderRun();
    expect(releaseChoice().value).toBe("ship");
    expect(planningCard().textContent).toContain("Saved pre-answer: Ship draft");

    await act(async () => startButton().click());
    expect(planningCard().textContent).toContain("Applied pre-answer: Ship draft");
    act(() => root.unmount());
    root = createRoot(container);
    await renderRun();
    expect(planningCard().textContent).toContain("Applied pre-answer: Ship draft");
    expect(readEvents().at(-1)).toMatchObject({ type: "run_finished", data: { outcome: "done" } });
  });

  it("refuses unapproved, cross-origin, wrong-pin and imported writes without appending", async () => {
    const { flowHash } = await plan();
    const save = { intent: "preanswer", flowHash, stepId: "release", choiceKey: "ship" };
    const planned = readEvents();
    expect((await post(save)).status).toBe(409);
    expect(readEvents()).toEqual(planned);

    expect((await post({ intent: "approve", flowHash })).status).toBe(200);
    const approved = readEvents();
    await expect(post(save, "https://elsewhere.example")).rejects.toMatchObject({ status: 403 });
    expect(readEvents()).toEqual(approved);
    const wrongHash = (flowHash[0] === "a" ? "b" : "a") + flowHash.slice(1);
    expect((await post({ ...save, flowHash: wrongHash })).status).toBe(409);
    expect(readEvents()).toEqual(approved);

    const ledgerDir = path.join(projectRoot, ".deck", "runs", runId);
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, "flow.yaml"), flowYaml);
    const store = openFlowsStore(projectId, { dataRoot, readonly: true });
    try {
      fs.writeFileSync(path.join(ledgerDir, "events.jsonl"), store.exportProjectionLines(runId).join("\n") + "\n");
    } finally {
      store.close();
    }

    vi.stubEnv("FLOWS_DATA_ROOT", path.join(scratch, "imported"));
    expect((await post({ intent: "import" })).status).toBe(200);
    const refusal = await post(save);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({ error: "Imported flow runs are read-only." });
    expect(readEvents()).toEqual(approved);
    await renderRun();
    expect(container.textContent).toContain("Imported history (read-only).");
    expect(container.querySelector('select[name="choiceKey"]')).toBeNull();
  });
});
