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
import { withInboxLock } from "~/lib/safe-fs.server";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ws: string;
let saved: string | undefined;
let savedPort: string | undefined;
let savedOrigins: string | undefined;

beforeEach(() => {
  // The origin allowlist default depends on PORT and VOICE_ALLOWED_ORIGINS;
  // pin both so the tests do not depend on the machine's environment.
  savedPort = process.env["PORT"];
  savedOrigins = process.env["VOICE_ALLOWED_ORIGINS"];
  delete process.env["PORT"];
  delete process.env["VOICE_ALLOWED_ORIGINS"];
  ws = mkdtempSync();
  saved = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
});

afterEach(() => {
  if (savedPort === undefined) delete process.env["PORT"];
  else process.env["PORT"] = savedPort;
  if (savedOrigins === undefined) delete process.env["VOICE_ALLOWED_ORIGINS"];
  else process.env["VOICE_ALLOWED_ORIGINS"] = savedOrigins;
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

  const postWith = (headers: Record<string, string>) => {
    const f = new FormData();
    f.set("intent", "create");
    f.set("name", "o");
    f.set("content", "x");
    return action({
      request: new Request("http://deck.local:5173/api/drafts", { method: "POST", body: f, headers }),
    } as never);
  };

  it("refuses cross-origin browser writes and allows allowlisted and header-less ones", async () => {
    const savedOrigins = process.env["VOICE_ALLOWED_ORIGINS"];
    delete process.env["VOICE_ALLOWED_ORIGINS"];
    try {
      expect((await postWith({ origin: "http://evil.example" })).status).toBe(403);
      expect((await postWith({ origin: "null" })).status).toBe(403);
      expect((await postWith({ "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await postWith({ "sec-fetch-site": "same-site" })).status).toBe(403);
      // A matching Origin does not rescue a cross-site fetch.
      expect(
        (await postWith({ origin: "http://localhost:4242", "sec-fetch-site": "cross-site" })).status
      ).toBe(403);
      expect(fs.existsSync(draftFile("o.md"))).toBe(false);
      // Default allowlist: this app's own origin.
      expect(
        (await postWith({ origin: "http://localhost:4242", "sec-fetch-site": "same-origin" })).status
      ).toBe(200);
      expect(fs.existsSync(draftFile("o.md"))).toBe(true);
      fs.rmSync(draftFile("o.md"));
      expect((await postWith({})).status).toBe(200);
    } finally {
      if (savedOrigins === undefined) delete process.env["VOICE_ALLOWED_ORIGINS"];
      else process.env["VOICE_ALLOWED_ORIGINS"] = savedOrigins;
    }
  });

  it("DNS rebinding: an Origin that matches the attacker's own Host is still refused", async () => {
    const saved = process.env["VOICE_ALLOWED_ORIGINS"];
    delete process.env["VOICE_ALLOWED_ORIGINS"];
    try {
      const res = await postWith({
        origin: "http://rebind.evil.example:4242",
        host: "rebind.evil.example:4242",
        "sec-fetch-site": "same-origin",
      });
      expect(res.status).toBe(403);
      expect(fs.existsSync(draftFile("o.md"))).toBe(false);
    } finally {
      if (saved !== undefined) process.env["VOICE_ALLOWED_ORIGINS"] = saved;
    }
  });

  it("an allowlisted origin works behind a proxy that rewrites Host", async () => {
    const saved = process.env["VOICE_ALLOWED_ORIGINS"];
    process.env["VOICE_ALLOWED_ORIGINS"] = "https://deck.tailnet.example";
    try {
      const res = await postWith({
        origin: "https://deck.tailnet.example",
        host: "127.0.0.1:4242",
        "sec-fetch-site": "same-origin",
      });
      expect(res.status).toBe(200);
      // The allowlist REPLACES the default.
      expect((await postWith({ origin: "http://localhost:4242" })).status).toBe(403);
    } finally {
      if (saved === undefined) delete process.env["VOICE_ALLOWED_ORIGINS"];
      else process.env["VOICE_ALLOWED_ORIGINS"] = saved;
    }
  });
});

describe("races and bounds", () => {
  it("returns the version this save wrote even if another writer lands during the sidecar wait", async () => {
    await saveDraft({ name: "seed", content: "s", create: true });
    const sidecar = draftFile(META_FILENAME);
    let saving!: Promise<Awaited<ReturnType<typeof saveDraft>>>;
    const holder = withInboxLock(sidecar, async () => {
      saving = saveDraft({ name: "a", content: "A", create: true });
      for (let i = 0; i < 400 && !fs.existsSync(draftFile("a.md")); i++) await sleep(5);
      fs.writeFileSync(draftFile("a.md"), "B from agent");
      await sleep(20);
    });
    await holder;
    const res = await saving;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.content).toBe("A");
    expect(res.draft.version).toBe(crypto.createHash("sha256").update("A").digest("hex"));
    // The next ordinary save from that version must conflict with the agent's B.
    const next = await saveDraft({ name: "a", content: "A2", baseVersion: res.draft.version });
    expect(!next.ok && next.conflict).toBe(true);
    expect(fs.readFileSync(draftFile("a.md"), "utf8")).toBe("B from agent");
  });

  it("does not write through a drafts folder swapped for a symlink while the save was queued", async () => {
    const outside = mkdtempSync();
    try {
      fs.mkdirSync(path.join(ws, "drafts"));
      const target = draftFile("new.md");
      let saving!: Promise<Awaited<ReturnType<typeof saveDraft>>>;
      await withInboxLock(target, async () => {
        saving = saveDraft({ name: "new", content: "x", create: true });
        // Swap the folder, and carry the held lock across so the waiter keeps waiting.
        fs.renameSync(path.join(ws, "drafts"), path.join(ws, "drafts-old"));
        fs.symlinkSync(outside, path.join(ws, "drafts"));
        fs.copyFileSync(path.join(ws, "drafts-old", "new.md.lock"), path.join(outside, "new.md.lock"));
        await sleep(40);
      });
      const res = await saving;
      expect(res.ok).toBe(false);
      expect(fs.existsSync(path.join(outside, "new.md"))).toBe(false);
      expect(fs.readdirSync(outside).filter((f) => !f.endsWith(".lock"))).toEqual([]);
    } finally {
      rmSync(outside);
    }
  });

  it("never reads a file over the cap: read answers 413, list still shows it, save refuses", async () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    fs.writeFileSync(draftFile("huge.md"), "x".repeat(1024 * 1024 + 1));
    const r = readDraft("huge");
    expect(!r.ok && r.status).toBe(413);
    expect(listDrafts().map((d) => d.name)).toContain("huge.md");
    const s = await saveDraft({ name: "huge", content: "small", force: true });
    expect(!s.ok && s.status).toBe(413);
  });

  it("keeps a copy of a corrupt sidecar before replacing it", async () => {
    await saveDraft({ name: "a", content: "one", create: true });
    fs.writeFileSync(draftFile(META_FILENAME), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await saveDraft({ name: "b", content: "two", create: true });
    warn.mockRestore();
    expect(fs.readFileSync(draftFile(META_FILENAME + ".bad"), "utf8")).toBe("{not json");
    expect(JSON.parse(fs.readFileSync(draftFile(META_FILENAME), "utf8")).files["b.md"]).toBeTruthy();
  });

  it("does not follow a symlink planted at the .bad backup path", async () => {
    const outside = mkdtempSync();
    try {
      await saveDraft({ name: "a", content: "one", create: true });
      fs.writeFileSync(path.join(outside, "victim.txt"), "keep me");
      fs.writeFileSync(draftFile(META_FILENAME), "{not json");
      fs.symlinkSync(path.join(outside, "victim.txt"), draftFile(META_FILENAME + ".bad"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await saveDraft({ name: "b", content: "two", create: true });
      warn.mockRestore();
      expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("keep me");
      expect(fs.lstatSync(draftFile(META_FILENAME + ".bad")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(draftFile(META_FILENAME + ".bad"), "utf8")).toBe("{not json");
    } finally {
      rmSync(outside);
    }
  });

  it("treats an oversized sidecar as unreadable rather than loading it", async () => {
    await saveDraft({ name: "a", content: "one", create: true });
    fs.writeFileSync(draftFile(META_FILENAME), "x".repeat(1024 * 1024 + 1));
    const r = readDraft("a");
    expect(r.ok && r.draft.writer).toBe("agent");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await saveDraft({ name: "b", content: "two", create: true });
    warn.mockRestore();
    expect(res.ok).toBe(true); // the draft is saved; the sidecar failure is logged
    expect(fs.statSync(draftFile(META_FILENAME)).size).toBe(1024 * 1024 + 1);
  });

  // A blocked synchronous open cannot be interrupted by vitest's per-test
  // timeout, so these run the real module in a child process with a hard
  // timeout: a regression FAILS here instead of hanging the suite.
  const hasMkfifo = spawnSync("mkfifo", ["--help"]).error?.code !== "ENOENT";

  function runInChild(body: string): { timedOut: boolean; out: string } {
    const dir = mkdtempSync();
    try {
      const script = path.join(dir, "child.mjs");
      const mod = pathToFileURL(path.resolve(__dirname, "..", "app", "lib", "drafts.server.ts")).href;
      fs.writeFileSync(script, `const m = await import(${JSON.stringify(mod)});\n${body}\n`);
      const r = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, WORKSPACE_ROOT: ws, MC_SANDBOX_ONLY: "1" },
        timeout: 20_000,
        encoding: "utf8",
      });
      return { timedOut: r.error !== undefined || r.signal !== null, out: String(r.stdout) + String(r.stderr) };
    } finally {
      rmSync(dir);
    }
  }

  it.skipIf(!hasMkfifo)("does not block on a FIFO named like a draft, or a symlink to a FIFO inside drafts/", () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    execFileSync("mkfifo", [draftFile("pipe.md")]);
    execFileSync("mkfifo", [draftFile("target.fifo")]);
    fs.symlinkSync(draftFile("target.fifo"), draftFile("linked.md"));
    const { timedOut, out } = runInChild(`
      const a = m.readDraft("pipe");
      const b = m.readDraft("linked");
      const names = m.listDrafts().map((d) => d.name);
      console.log(JSON.stringify({ a: a.ok, b: b.ok, names }));
    `);
    expect(timedOut).toBe(false);
    const res = JSON.parse(out.trim().split("\n").pop()!);
    expect(res).toEqual({ a: false, b: false, names: [] });
  });

  it.skipIf(!hasMkfifo)("refuses to save over a FIFO instead of blocking", () => {
    fs.mkdirSync(path.join(ws, "drafts"));
    execFileSync("mkfifo", [draftFile("pipe.md")]);
    const { timedOut, out } = runInChild(`
      const r = await m.saveDraft({ name: "pipe", content: "x", baseVersion: null });
      console.log(JSON.stringify({ ok: r.ok }));
    `);
    expect(timedOut).toBe(false);
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ ok: false });
  });
});

describe("dev launcher", () => {
  it("passes the origin allowlist to the app, not only to the voice proxy", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "dev.mjs"), "utf8");
    const appEnv = src.slice(src.indexOf("const appEnv"), src.indexOf("const child = spawn"));
    expect(appEnv).toContain("VOICE_ALLOWED_ORIGINS: proxyEnv.VOICE_ALLOWED_ORIGINS");
  });
});
