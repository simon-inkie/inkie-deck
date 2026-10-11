/**
 * model-selector.test.ts - M4-M6: the per-agent model selector.
 *
 * The e2e server runs with MC_USER unset (= the operator instance), so the
 * chip renders; the principal-instance invisibility is unit-pinned
 * (test/agent-model.test.ts gates both route verbs on MC_USER=robin).
 * AGENTS_ROOT points at a temp copy of fixtures/agents (e2e/setup.mjs):
 * scribe runs the claude runtime with NO .model (inherit default); quill runs
 * codex (no catalog options -> no control).
 *
 * Every write lands in the temp agents root; assertGitClean proves
 * the repo (and the real ~/agents) untouched.
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, resetFixtureAgents, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
  resetFixtureAgents();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

test("M5/M6: chip shows the CONFIGURED model ('default' when .model absent) with the divergence tooltip", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  const chip = page.getByTestId("model-selector-chip");
  await expect(chip).toBeVisible();
  // No .model file in the fixture -> inherit the global default.
  await expect(page.getByTestId("model-selector-current")).toHaveText("default");
  // M6 display honesty: configured-not-running, said out loud.
  await expect(chip).toHaveAttribute(
    "title",
    "Configured model; a manual in-session /model switch may differ until restart"
  );

  // The dropdown lists the claude catalog options + the persist-only note.
  await chip.click();
  await expect(page.getByTestId("model-option-opus")).toBeVisible();
  await expect(page.getByTestId("model-option-sonnet")).toBeVisible();
  await expect(page.getByTestId("model-option-haiku")).toBeVisible();
  await expect(page.getByTestId("model-selector-note")).toContainText(
    "applies on the agent's next restart"
  );
});

test("M4/M5: picking a model persists .model and the chip + note update (applies on restart)", async ({
  page,
}) => {
  const agentsRoot = process.env["AGENTS_ROOT"]!;
  const modelFile = path.join(agentsRoot, "scribe", ".model");
  expect(fs.existsSync(modelFile)).toBe(false);

  await page.goto("/threads/scribe");
  await page.getByTestId("model-selector-chip").click();
  await page.getByTestId("model-option-sonnet").click();

  // The chip reflects the pick (optimistic, then loader-confirmed).
  await expect(page.getByTestId("model-selector-current")).toHaveText(
    "Sonnet 4.6"
  );

  // Persist-only v1: the file is the receipt, single line, exact id.
  await expect(() => {
    expect(fs.readFileSync(modelFile, "utf8")).toBe("sonnet\n");
  }).toPass();

  // Reopen: the saved confirmation carries the applies-on-restart honesty.
  await page.getByTestId("model-selector-chip").click();
  await expect(page.getByTestId("model-selector-note")).toContainText(
    "applies on the agent's next restart"
  );
});

test("M5: an agent whose runtime has no catalog options gets no control", async ({
  page,
}) => {
  // quill's fixture .runtime is codex - empty catalog block, structural absence.
  await page.goto("/threads/quill");
  await expect(page.getByTestId("thread-header")).toContainText("quill");
  await expect(page.getByTestId("model-selector-chip")).not.toBeVisible();
});

test("M4: the route 400s invalid agent/model shapes and writes nothing", async ({
  page,
}) => {
  const agentsRoot = process.env["AGENTS_ROOT"]!;

  const badModel = await page.request.post("/api/agent-model", {
    form: { agent: "scribe", model: "gpt-9" },
  });
  expect(badModel.status()).toBe(400);

  const badAgent = await page.request.post("/api/agent-model", {
    form: { agent: "../scribe", model: "opus" },
  });
  expect(badAgent.status()).toBe(400);

  const ghost = await page.request.post("/api/agent-model", {
    form: { agent: "ghost", model: "opus" },
  });
  expect(ghost.status()).toBe(400);

  expect(fs.existsSync(path.join(agentsRoot, "scribe", ".model"))).toBe(false);
});
