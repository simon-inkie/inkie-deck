/**
 * Tests for the per-agent model selector seam (M4-M6).
 *
 * Covers: AGENTS_ROOT resolution (default ~/agents, tilde expansion),
 * catalog read + shape validation, the GET view-model (runtime/.model/
 * options, degrade-to-empty), the validated atomic .model write, the
 * operator-only instance gate, and the api route's loader/action contract
 * (403 on a principal instance, 400 on invalid agent/model, the
 * persisted/liveSwitched response).
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import {
  resolveAgentsRoot,
  readModelCatalog,
  getAgentModelInfo,
  setAgentModel,
} from "~/lib/agent-model.server";
import { modelSelectorEnabled } from "~/lib/instance.server";
import { loader, action } from "../app/routes/api.agent-model";

const CATALOG = {
  claude: [
    { id: "opus", label: "Opus 4.8" },
    { id: "sonnet", label: "Sonnet 4.6" },
    { id: "haiku", label: "Haiku 4.5" },
  ],
  agy: [],
  codex: [],
};

/** Build a fixture agents root: bin/model-catalog.json + agent homes. */
function seedAgentsRoot(root: string): void {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "bin", "model-catalog.json"),
    JSON.stringify(CATALOG),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "quill"));
  fs.writeFileSync(path.join(root, "quill", ".runtime"), "claude\n", "utf8");
  fs.writeFileSync(path.join(root, "quill", ".model"), "sonnet\n", "utf8");
  fs.mkdirSync(path.join(root, "scribe"));
  fs.writeFileSync(path.join(root, "scribe", ".runtime"), "claude\n", "utf8");
  fs.mkdirSync(path.join(root, "sprout"));
  fs.writeFileSync(path.join(root, "sprout", ".runtime"), "codex\n", "utf8");
}

let root: string;

beforeEach(() => {
  root = mkdtempSync();
  seedAgentsRoot(root);
});

afterEach(() => {
  rmSync(root);
});

// ---------------------------------------------------------------------------
// resolveAgentsRoot
// ---------------------------------------------------------------------------

describe("resolveAgentsRoot", () => {
  it("defaults to ~/agents when unset/empty (the contract default)", () => {
    const expected = path.join(os.homedir(), "agents");
    expect(resolveAgentsRoot({})).toBe(expected);
    expect(resolveAgentsRoot({ AGENTS_ROOT: "" })).toBe(expected);
    expect(resolveAgentsRoot({ AGENTS_ROOT: "   " })).toBe(expected);
  });
  it("expands a leading tilde against the home directory", () => {
    expect(resolveAgentsRoot({ AGENTS_ROOT: "~/agents" })).toBe(
      path.join(os.homedir(), "agents")
    );
    expect(resolveAgentsRoot({ AGENTS_ROOT: "~" })).toBe(os.homedir());
  });
  it("passes an absolute path through", () => {
    expect(resolveAgentsRoot({ AGENTS_ROOT: root })).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// readModelCatalog
// ---------------------------------------------------------------------------

describe("readModelCatalog", () => {
  it("reads the catalog keyed by runtime", () => {
    const catalog = readModelCatalog({ AGENTS_ROOT: root });
    expect(catalog["claude"]).toHaveLength(3);
    expect(catalog["claude"]![1]).toEqual({ id: "sonnet", label: "Sonnet 4.6" });
    expect(catalog["agy"]).toEqual([]);
  });
  it("degrades to {} when the file is absent or unparseable", () => {
    expect(readModelCatalog({ AGENTS_ROOT: path.join(root, "nowhere") })).toEqual({});
    fs.writeFileSync(path.join(root, "bin", "model-catalog.json"), "{not json", "utf8");
    expect(readModelCatalog({ AGENTS_ROOT: root })).toEqual({});
  });
  it("drops malformed entries instead of trusting them", () => {
    fs.writeFileSync(
      path.join(root, "bin", "model-catalog.json"),
      JSON.stringify({
        claude: [
          { id: "opus", label: "Opus 4.8" },
          { id: "", label: "empty id" },
          { label: "no id" },
          "not-an-object",
        ],
        _doc: "string value, not an option list",
      }),
      "utf8"
    );
    const catalog = readModelCatalog({ AGENTS_ROOT: root });
    expect(catalog["claude"]).toEqual([{ id: "opus", label: "Opus 4.8" }]);
    expect(catalog["_doc"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAgentModelInfo
// ---------------------------------------------------------------------------

describe("getAgentModelInfo", () => {
  it("returns runtime + configured model + options for a configured agent", () => {
    expect(getAgentModelInfo({ AGENTS_ROOT: root }, "quill")).toEqual({
      runtime: "claude",
      model: "sonnet",
      options: CATALOG.claude,
    });
  });
  it("model is null when .model is absent (inherit the global default)", () => {
    const info = getAgentModelInfo({ AGENTS_ROOT: root }, "scribe");
    expect(info.runtime).toBe("claude");
    expect(info.model).toBeNull();
    expect(info.options).toHaveLength(3);
  });
  it("a runtime with an empty catalog block yields no options", () => {
    const info = getAgentModelInfo({ AGENTS_ROOT: root }, "sprout");
    expect(info.runtime).toBe("codex");
    expect(info.options).toEqual([]);
  });
  it("degrades to nulls/empty for unknown agents and invalid names", () => {
    const empty = { runtime: null, model: null, options: [] };
    expect(getAgentModelInfo({ AGENTS_ROOT: root }, "ghost")).toEqual(empty);
    expect(getAgentModelInfo({ AGENTS_ROOT: root }, "../quill")).toEqual(empty);
    expect(getAgentModelInfo({ AGENTS_ROOT: root }, "")).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// setAgentModel
// ---------------------------------------------------------------------------

describe("setAgentModel", () => {
  it("writes .model with a trailing newline (boot's $(cat) reads clean)", () => {
    const result = setAgentModel({ AGENTS_ROOT: root }, "scribe", "haiku");
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(root, "scribe", ".model"), "utf8")).toBe(
      "haiku\n"
    );
  });
  it("overwrites an existing pick and leaves no temp residue", () => {
    expect(setAgentModel({ AGENTS_ROOT: root }, "quill", "opus")).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(root, "quill", ".model"), "utf8")).toBe("opus\n");
    const leftovers = fs
      .readdirSync(path.join(root, "quill"))
      .filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
  it("rejects traversal-shaped and unknown agents without writing", () => {
    const bad = setAgentModel({ AGENTS_ROOT: root }, "../quill", "opus");
    expect(bad.ok).toBe(false);
    const ghost = setAgentModel({ AGENTS_ROOT: root }, "ghost", "opus");
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error).toContain("ghost");
  });
  it("rejects a model outside the runtime's catalog options", () => {
    const result = setAgentModel({ AGENTS_ROOT: root }, "quill", "gpt-9");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("gpt-9");
    // The configured pick is untouched by the rejected write.
    expect(fs.readFileSync(path.join(root, "quill", ".model"), "utf8")).toBe(
      "sonnet\n"
    );
  });
  it("rejects every model for a runtime with no options (codex v1)", () => {
    const result = setAgentModel({ AGENTS_ROOT: root }, "sprout", "opus");
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "sprout", ".model"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// modelSelectorEnabled (the operator-only instance gate)
// ---------------------------------------------------------------------------

describe("modelSelectorEnabled", () => {
  it("enabled on the operator instance (default user = alex)", () => {
    expect(modelSelectorEnabled({})).toBe(true);
    expect(modelSelectorEnabled({ MC_USER: "alex" })).toBe(true);
  });
  it("disabled on a principal instance (a second user's)", () => {
    expect(modelSelectorEnabled({ MC_USER: "robin" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// api.agent-model route (loader + action contract)
// ---------------------------------------------------------------------------

/** Unwrap a route return: plain object or react-router data() envelope. */
function unwrap(result: unknown): { status: number; body: any } {
  const r = result as { data?: unknown; init?: { status?: number } | null };
  if (r !== null && typeof r === "object" && "data" in r && "init" in r) {
    return { status: r.init?.status ?? 200, body: r.data };
  }
  return { status: 200, body: result };
}

function getRequest(agent: string): Request {
  return new Request(
    `http://localhost/api/agent-model?agent=${encodeURIComponent(agent)}`
  );
}

function postRequest(form: Record<string, string>): Request {
  return new Request("http://localhost/api/agent-model", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost" },
    body: new URLSearchParams(form),
  });
}

describe("api.agent-model route", () => {
  const savedAgentsRoot = process.env["AGENTS_ROOT"];
  const savedMcUser = process.env["MC_USER"];

  beforeEach(() => {
    process.env["AGENTS_ROOT"] = root;
    delete process.env["MC_USER"];
  });

  afterEach(() => {
    if (savedAgentsRoot === undefined) delete process.env["AGENTS_ROOT"];
    else process.env["AGENTS_ROOT"] = savedAgentsRoot;
    if (savedMcUser === undefined) delete process.env["MC_USER"];
    else process.env["MC_USER"] = savedMcUser;
  });

  it("GET returns { agent, runtime, model, options }", async () => {
    const { status, body } = unwrap(
      await loader({ request: getRequest("quill"), params: {}, context: {} } as any)
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      agent: "quill",
      runtime: "claude",
      model: "sonnet",
      options: CATALOG.claude,
    });
  });

  it("GET 400s on an invalid/missing agent name", async () => {
    for (const agent of ["../quill", "quill;ls", ""]) {
      const { status } = unwrap(
        await loader({ request: getRequest(agent), params: {}, context: {} } as any)
      );
      expect(status, agent).toBe(400);
    }
  });

  it("POST persists and reports persist-only (liveSwitched: false)", async () => {
    const { status, body } = unwrap(
      await action({
        request: postRequest({ agent: "scribe", model: "sonnet" }),
        params: {},
        context: {},
      } as any)
    );
    expect(status).toBe(200);
    expect(body).toEqual({ persisted: true, liveSwitched: false });
    expect(fs.readFileSync(path.join(root, "scribe", ".model"), "utf8")).toBe(
      "sonnet\n"
    );
  });

  it("POST 400s on a model outside the catalog and on bad payloads", async () => {
    const badModel = unwrap(
      await action({
        request: postRequest({ agent: "quill", model: "gpt-9" }),
        params: {},
        context: {},
      } as any)
    );
    expect(badModel.status).toBe(400);
    expect(badModel.body.error).toContain("gpt-9");

    const badAgent = unwrap(
      await action({
        request: postRequest({ agent: "../quill", model: "opus" }),
        params: {},
        context: {},
      } as any)
    );
    expect(badAgent.status).toBe(400);

    const missingField = unwrap(
      await action({
        request: postRequest({ agent: "quill" }),
        params: {},
        context: {},
      } as any)
    );
    expect(missingField.status).toBe(400);
  });

  it("both verbs 403 on a principal instance (MC_USER=robin), and nothing is written", async () => {
    process.env["MC_USER"] = "robin";
    const get = unwrap(
      await loader({ request: getRequest("quill"), params: {}, context: {} } as any)
    );
    expect(get.status).toBe(403);
    const post = unwrap(
      await action({
        request: postRequest({ agent: "scribe", model: "sonnet" }),
        params: {},
        context: {},
      } as any)
    );
    expect(post.status).toBe(403);
    expect(fs.existsSync(path.join(root, "scribe", ".model"))).toBe(false);
  });
});
