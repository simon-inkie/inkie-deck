/**
 * file-pins.test.ts - integration tests for FilePinsStore.
 *
 * Proves:
 *   - getPins() returns [] on a missing state file (graceful fallback).
 *   - pin/unpin/toggle persist, are idempotent, and round-trip across a fresh
 *     store over the same path.
 *   - Pin order is preserved (pin order = render order).
 *   - Per-thread + per-participant isolation (author-agnostic).
 *   - Corrupt JSON degrades to empty.
 *
 * Writes are confined to DATA_ROOT (mirrors FileQueueStore tests).
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import { FilePinsStore } from "~/lib/file-pins.server.js";

describe("FilePinsStore", () => {
  let sandbox: string;
  let statePath: string;
  let store: FilePinsStore;
  let savedDataRoot: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync();
    statePath = path.join(sandbox, "file-pins.json");
    store = new FilePinsStore(statePath);
    savedDataRoot = process.env["DATA_ROOT"];
    process.env["DATA_ROOT"] = sandbox;
  });

  afterEach(() => {
    if (savedDataRoot === undefined) delete process.env["DATA_ROOT"];
    else process.env["DATA_ROOT"] = savedDataRoot;
    rmSync(sandbox);
  });

  it("getPins() returns [] when state file does not exist", () => {
    expect(store.getPins("quill", "alex")).toEqual([]);
  });

  it("pins a file and persists it", () => {
    store.pin("quill", "alex", "/x/a.md");
    expect(store.getPins("quill", "alex")).toEqual(["/x/a.md"]);
    // Fresh store over the same path reads it back.
    const reload = new FilePinsStore(statePath);
    expect(reload.getPins("quill", "alex")).toEqual(["/x/a.md"]);
  });

  it("pin is idempotent (no duplicate)", () => {
    store.pin("quill", "alex", "/x/a.md");
    store.pin("quill", "alex", "/x/a.md");
    expect(store.getPins("quill", "alex")).toEqual(["/x/a.md"]);
  });

  it("preserves pin order (render order)", () => {
    store.pin("quill", "alex", "/x/a.md");
    store.pin("quill", "alex", "/x/b.md");
    store.pin("quill", "alex", "/x/c.md");
    expect(store.getPins("quill", "alex")).toEqual(["/x/a.md", "/x/b.md", "/x/c.md"]);
  });

  it("unpins a file (idempotent when absent)", () => {
    store.pin("quill", "alex", "/x/a.md");
    store.pin("quill", "alex", "/x/b.md");
    store.unpin("quill", "alex", "/x/a.md");
    expect(store.getPins("quill", "alex")).toEqual(["/x/b.md"]);
    // Unpinning something not pinned is a no-op.
    expect(store.unpin("quill", "alex", "/x/zzz.md")).toEqual(["/x/b.md"]);
  });

  it("togglePin flips and reports pinned state", () => {
    const first = store.togglePin("quill", "alex", "/x/a.md");
    expect(first.pinned).toBe(true);
    expect(first.pins).toEqual(["/x/a.md"]);
    const second = store.togglePin("quill", "alex", "/x/a.md");
    expect(second.pinned).toBe(false);
    expect(second.pins).toEqual([]);
  });

  it("isolates pins per thread and per participant (author-agnostic)", () => {
    store.pin("quill", "alex", "/x/a.md");
    store.pin("quill", "robin", "/x/b.md");
    store.pin("scribe", "alex", "/x/c.md");
    expect(store.getPins("quill", "alex")).toEqual(["/x/a.md"]);
    expect(store.getPins("quill", "robin")).toEqual(["/x/b.md"]);
    expect(store.getPins("scribe", "alex")).toEqual(["/x/c.md"]);
  });

  it("degrades to empty on corrupt JSON", () => {
    fs.writeFileSync(statePath, "{ not valid json", "utf8");
    expect(store.getPins("quill", "alex")).toEqual([]);
  });

  it("writes a schema-valid file (version 1)", () => {
    store.pin("quill", "alex", "/x/a.md");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.threads["quill::alex"].pins).toEqual(["/x/a.md"]);
  });
});
