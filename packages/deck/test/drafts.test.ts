/**
 * drafts.test.ts - workspace Markdown drafts (#66). Every case runs against a
 * throwaway workspace in a temp dir; nothing touches a real tree.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  draftsEnabled,
  listDrafts,
  normaliseDraftName,
  readDraft,
  saveDraft,
  META_FILENAME,
} from "~/lib/drafts.server";
import { loader, action } from "~/routes/api.drafts";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

let ws: string;
let saved: string | undefined;

beforeEach(() => {
  ws = mkdtempSync();
  saved = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
});

afterEach(() => {
  if (saved === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = saved;
  rmSync(ws);
});

const draftFile = (n: string) => path.join(ws, "drafts", n);

describe("normaliseDraftName", () => {
  it("adds .md and accepts flat names", () => {
    expect(normaliseDraftName("notes")).toBe("notes.md");
    expect(normaliseDraftName("Plan-1.v2.md")).toBe("Plan-1.v2.md");
  });
  it.each(["", "  ", "../x", "a/b", ".hidden", "a\\b", "x..y", "a\0b"])(
    "rejects %j",
    (n) => {
      expect(normaliseDraftName(n)).toBeNull();
    }
  );
});

describe("configuration", () => {
  it("is disabled without WORKSPACE_ROOT and with a relative one", () => {
    delete process.env["WORKSPACE_ROOT"];
    expect(draftsEnabled(process.env)).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["WORKSPACE_ROOT"] = "relative/dir";
    expect(draftsEnabled(process.env)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("absolute"));
    warn.mockRestore();
  });
});

describe("create, read, save", () => {
  it("creates a normal .md file under <workspace>/drafts", async () => {
    const res = await saveDraft({ name: "first", content: "# Hi\n", create: true });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(draftFile("first.md"), "utf8")).toBe("# Hi\n");
    if (res.ok) {
      expect(res.draft.writer).toBe("person");
      expect(Date.parse(res.draft.savedAt)).not.toBeNaN();
    }
  });

  it("refuses to create over an existing draft", async () => {
    await saveDraft({ name: "a", content: "one", create: true });
    const again = await saveDraft({ name: "a", content: "two", create: true });
    expect(again.ok).toBe(false);
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("one");
  });

  it("saves with the loaded version and round-trips", async () => {
    const c = await saveDraft({ name: "a", content: "one", create: true });
    if (!c.ok) throw new Error("create failed");
    const s = await saveDraft({ name: "a", content: "two", baseVersion: c.draft.version });
    expect(s.ok).toBe(true);
    const r = readDraft("a");
    expect(r.ok && r.draft.content).toBe("two");
  });

  it("lists drafts and ignores non-draft files and the sidecar", async () => {
    await saveDraft({ name: "a", content: "x", create: true });
    fs.writeFileSync(draftFile("notes.txt"), "no");
    expect(fs.existsSync(draftFile(META_FILENAME))).toBe(true);
    expect(listDrafts().map((d) => d.name)).toEqual(["a.md"]);
  });

  it("returns 404 for a missing draft and 400 for a bad name", () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    const missing = readDraft("nope");
    expect(!missing.ok && missing.status).toBe(404);
    const bad = readDraft("../secret");
    expect(!bad.ok && bad.status).toBe(400);
  });

  it("rejects oversized content", async () => {
    const res = await saveDraft({ name: "big", content: "x".repeat(1024 * 1024 + 1), create: true });
    expect(!res.ok && res.status).toBe(413);
  });
});

describe("line endings, odd paths and the sidecar", () => {
  it("stores LF and returns content equal to what the editor holds", async () => {
    const res = await saveDraft({ name: "a", content: "a\r\nb\r\n", create: true });
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("a\nb\n");
    expect(res.ok && res.draft.content).toBe("a\nb\n");
  });

  it("returns a JSON error, not a throw, when the draft path is a directory", async () => {
    fs.mkdirSync(draftFile("dir.md"), { recursive: true });
    const res = await saveDraft({ name: "dir", content: "x", baseVersion: null });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(400);
  });

  it("still reports success when the sidecar cannot be updated after the file is written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(draftFile(META_FILENAME), { recursive: true }); // makes the sidecar write fail
    const res = await saveDraft({ name: "a", content: "kept", create: true });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("kept");
    expect(res.ok && res.draft.content).toBe("kept");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // A retry from the returned version is not a conflict.
    if (!res.ok) throw new Error("unreachable");
    const again = await saveDraft({ name: "a", content: "kept 2", baseVersion: res.draft.version });
    expect(again.ok).toBe(true);
  });

  it("keeps every person record when different drafts save concurrently", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `d${i}`);
    const results = await Promise.all(
      names.map((n) => saveDraft({ name: n, content: n, create: true }))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(listDrafts().every((d) => d.writer === "person")).toBe(true);
    expect(listDrafts()).toHaveLength(8);
  });
});

describe("who wrote the current version", () => {
  it("reports the agent after an outside write, and the person after the next editor save", async () => {
    const c = await saveDraft({ name: "a", content: "mine", create: true });
    if (!c.ok) throw new Error("create failed");

    fs.writeFileSync(draftFile("a.md"), "agent revision");
    const afterAgent = readDraft("a");
    expect(afterAgent.ok && afterAgent.draft.writer).toBe("agent");
    expect(listDrafts()[0]?.writer).toBe("agent");

    const agentVersion = afterAgent.ok ? afterAgent.draft.version : "";
    const s = await saveDraft({ name: "a", content: "person revision", baseVersion: agentVersion });
    expect(s.ok && s.draft.writer).toBe("person");
  });

  it("reports the agent for a file the Deck never wrote", () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    fs.writeFileSync(draftFile("from-agent.md"), "hello");
    const r = readDraft("from-agent");
    expect(r.ok && r.draft.writer).toBe("agent");
  });

  it("reports the agent when the sidecar is corrupt", async () => {
    await saveDraft({ name: "a", content: "mine", create: true });
    fs.writeFileSync(draftFile(META_FILENAME), "{not json");
    const r = readDraft("a");
    expect(r.ok && r.draft.writer).toBe("agent");
  });
});

describe("conflicts", () => {
  it("refuses a stale save, returns the current copy, and leaves the file alone", async () => {
    const c = await saveDraft({ name: "a", content: "v1", create: true });
    if (!c.ok) throw new Error("create failed");
    fs.writeFileSync(draftFile("a.md"), "agent v2");

    const stale = await saveDraft({ name: "a", content: "person v2", baseVersion: c.draft.version });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.conflict).toBe(true);
      expect(stale.status).toBe(409);
      expect(stale.current?.content).toBe("agent v2");
      expect(stale.current?.writer).toBe("agent");
    }
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("agent v2");
  });

  it("force overwrites after a conflict", async () => {
    const c = await saveDraft({ name: "a", content: "v1", create: true });
    if (!c.ok) throw new Error("create failed");
    fs.writeFileSync(draftFile("a.md"), "agent v2");
    const forced = await saveDraft({
      name: "a",
      content: "person v2",
      baseVersion: c.draft.version,
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("person v2");
  });

  it("flags a conflict when the editor thought the file was new but it exists", async () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    fs.writeFileSync(draftFile("a.md"), "already here");
    const res = await saveDraft({ name: "a", content: "x", baseVersion: null });
    expect(!res.ok && res.conflict).toBe(true);
  });

  it("flags a conflict when the file was deleted under the editor", async () => {
    const c = await saveDraft({ name: "a", content: "v1", create: true });
    if (!c.ok) throw new Error("create failed");
    fs.rmSync(draftFile("a.md"));
    const res = await saveDraft({ name: "a", content: "x", baseVersion: c.draft.version });
    expect(!res.ok && res.conflict).toBe(true);
  });

  it("two concurrent saves from the same base: exactly one wins", async () => {
    const c = await saveDraft({ name: "a", content: "v1", create: true });
    if (!c.ok) throw new Error("create failed");
    const [x, y] = await Promise.all([
      saveDraft({ name: "a", content: "X", baseVersion: c.draft.version }),
      saveDraft({ name: "a", content: "Y", baseVersion: c.draft.version }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe("confinement", () => {
  it("never writes outside the drafts folder, even via a symlink", async () => {
    const outside = mkdtempSync();
    try {
      fs.mkdirSync(path.join(ws, "drafts"));
      fs.symlinkSync(path.join(outside, "target.md"), draftFile("link.md"));
      const res = await saveDraft({ name: "link", content: "pwned", create: true });
      expect(res.ok).toBe(false);
      expect(fs.existsSync(path.join(outside, "target.md"))).toBe(false);

      fs.writeFileSync(path.join(outside, "secret.md"), "secret");
      fs.symlinkSync(path.join(outside, "secret.md"), draftFile("peek.md"));
      const r = readDraft("peek");
      expect(r.ok).toBe(false);
      expect(listDrafts().map((d) => d.name)).not.toContain("peek.md");
    } finally {
      rmSync(outside);
    }
  });

  it("refuses a drafts folder that is a symlink out of the workspace", async () => {
    const outside = mkdtempSync();
    try {
      fs.symlinkSync(outside, path.join(ws, "drafts"));
      const res = await saveDraft({ name: "a", content: "x", create: true });
      expect(res.ok).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside);
    }
  });
});

describe("api route", () => {
  const post = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return action({ request: new Request("http://x/api/drafts", { method: "POST", body: f }) } as never);
  };
  const get = (q = "") =>
    loader({ request: new Request(`http://x/api/drafts${q}`) } as never);

  it("creates, lists, reads and answers 409 on a stale save", async () => {
    const created = await post({ intent: "create", name: "r", content: "one" });
    expect(created.status).toBe(200);
    const { draft } = await created.json();

    const list = await (await get()).json();
    expect(list.drafts.map((d: { name: string }) => d.name)).toEqual(["r.md"]);

    fs.writeFileSync(draftFile("r.md"), "agent");
    const stale = await post({ intent: "save", name: "r", content: "two", baseVersion: draft.version });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.conflict).toBe(true);
    expect(body.current.content).toBe("agent");

    const read = await get("?name=r.md");
    expect((await read.json()).draft.content).toBe("agent");
  });

  it("a multipart save of multi-line text is stored LF and reloads clean", async () => {
    const created = await post({ intent: "create", name: "m", content: "" });
    const { draft } = await created.json();
    const saved = await post({
      intent: "save",
      name: "m",
      content: "line one\nline two\n",
      baseVersion: draft.version,
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.draft.content).toBe("line one\nline two\n");
    expect(fs.readFileSync(draftFile("m.md"), "utf8")).toBe("line one\nline two\n");
    const read = await (await get("?name=m.md")).json();
    expect(read.draft.content).toBe("line one\nline two\n");
    expect(read.draft.version).toBe(body.draft.version);
  });

  it("404s when no workspace is configured", async () => {
    delete process.env["WORKSPACE_ROOT"];
    expect((await get()).status).toBe(404);
    expect((await post({ intent: "create", name: "r", content: "" })).status).toBe(404);
  });
});
