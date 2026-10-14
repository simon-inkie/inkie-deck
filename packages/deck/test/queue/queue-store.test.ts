/**
 * queue-store.test.ts - Integration tests for FileQueueStore
 *
 * Proves:
 *   1. getHandled() returns empty Set on missing state file (ENOENT graceful fallback).
 *   2. getDeadlines() returns empty Map on missing state file.
 *   3. Corrupt JSON returns EMPTY_STATE (schema mismatch fallback).
 *   4. markHandled(id) adds id and persists; double call yields exactly one entry.
 *   5. setDeadline(id, iso) persists anchor; second call is a no-op (first wins).
 *   6. A fresh FileQueueStore over the same path reads back identical data (reload).
 *   7. The written file is valid against QueueStateSchema (version 1).
 *
 * Threat: T-03-01 (DoS via corrupt state - safeParse + try/catch returns EMPTY_STATE).
 * Threat: T-03-02 (Tampering - writes go only to statePath under data/, isolated temp dir).
 * Threat: T-03-03 (Tampering - atomicWrite temp+rename means no half-written files).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import { FileQueueStore } from "~/lib/queue.server.js";

describe("FileQueueStore (integration)", () => {
  let sandbox: string;
  let storePath: string;
  let store: FileQueueStore;
  let savedDataRoot: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync();
    storePath = path.join(sandbox, "queue-state.json");
    store = new FileQueueStore(storePath);
    // State writes are confined to DATA_ROOT.
    savedDataRoot = process.env["DATA_ROOT"];
    process.env["DATA_ROOT"] = sandbox;
  });

  afterEach(() => {
    if (savedDataRoot === undefined) {
      delete process.env["DATA_ROOT"];
    } else {
      process.env["DATA_ROOT"] = savedDataRoot;
    }
    rmSync(sandbox);
  });

  // ---------------------------------------------------------------------------
  // Graceful fallback on missing or corrupt state
  // ---------------------------------------------------------------------------

  it("getHandled() returns empty Set when state file does not exist", async () => {
    const result = await store.getHandled();
    expect(result.size).toBe(0);
  });

  it("getDeadlines() returns empty Map when state file does not exist", async () => {
    const result = await store.getDeadlines();
    expect(result.size).toBe(0);
  });

  it("getHandled() returns empty Set on corrupt JSON (T-03-01)", async () => {
    fs.writeFileSync(storePath, "this is not valid json", "utf8");
    const result = await store.getHandled();
    expect(result.size).toBe(0);
  });

  it("getDeadlines() returns empty Map on schema mismatch (T-03-01)", async () => {
    // Valid JSON but wrong schema (missing version, wrong shape)
    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: 99, items: ["wrong-shape"] }),
      "utf8"
    );
    const result = await store.getDeadlines();
    expect(result.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // markHandled: monotonic, idempotent, persists
  // ---------------------------------------------------------------------------

  it("markHandled(id) adds the id to the handled set", async () => {
    await store.markHandled("item-abc");
    const result = await store.getHandled();
    expect(result.has("item-abc")).toBe(true);
  });

  it("markHandled(id) called twice yields exactly one entry (idempotent, monotonic)", async () => {
    await store.markHandled("item-abc");
    await store.markHandled("item-abc");
    const result = await store.getHandled();
    expect(result.size).toBe(1);
    expect(result.has("item-abc")).toBe(true);
  });

  it("markHandled does not remove previously handled ids (monotonic)", async () => {
    await store.markHandled("item-1");
    await store.markHandled("item-2");
    const result = await store.getHandled();
    expect(result.has("item-1")).toBe(true);
    expect(result.has("item-2")).toBe(true);
    expect(result.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // setDeadline: first-write-wins, persists
  // ---------------------------------------------------------------------------

  it("setDeadline(id, iso) persists the deadline anchor", async () => {
    await store.setDeadline("item-abc", "2026-06-10T14:30:00Z");
    const result = await store.getDeadlines();
    expect(result.get("item-abc")).toBe("2026-06-10T14:30:00Z");
  });

  it("setDeadline(id, iso) called twice is a no-op (first anchor wins)", async () => {
    await store.setDeadline("item-abc", "2026-06-10T14:30:00Z");
    await store.setDeadline("item-abc", "2099-01-01T00:00:00Z");
    const result = await store.getDeadlines();
    expect(result.get("item-abc")).toBe("2026-06-10T14:30:00Z");
  });

  // ---------------------------------------------------------------------------
  // Reload survival: fresh store over same path reads back identical data
  // ---------------------------------------------------------------------------

  it("a fresh FileQueueStore over the same path reads back identical handled set", async () => {
    await store.markHandled("item-reload");
    const freshStore = new FileQueueStore(storePath);
    const result = await freshStore.getHandled();
    expect(result.has("item-reload")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("a fresh FileQueueStore over the same path reads back identical deadlines map", async () => {
    await store.setDeadline("item-reload", "2026-06-15T09:00:00Z");
    const freshStore = new FileQueueStore(storePath);
    const result = await freshStore.getDeadlines();
    expect(result.get("item-reload")).toBe("2026-06-15T09:00:00Z");
    expect(result.size).toBe(1);
  });

  it("reload after markHandled + setDeadline reads back both correctly", async () => {
    await store.markHandled("item-a");
    await store.setDeadline("item-b", "2026-06-20T12:00:00Z");

    const freshStore = new FileQueueStore(storePath);
    const handled = await freshStore.getHandled();
    const deadlines = await freshStore.getDeadlines();

    expect(handled.has("item-a")).toBe(true);
    expect(deadlines.get("item-b")).toBe("2026-06-20T12:00:00Z");
  });

  // ---------------------------------------------------------------------------
  // Written file is valid against QueueStateSchema (version 1)
  // ---------------------------------------------------------------------------

  it("the written file has version 1 and correct shape", async () => {
    await store.markHandled("item-shape");
    await store.setDeadline("item-shape", "2026-06-10T00:00:00Z");

    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed["version"]).toBe(1);
    expect(Array.isArray(parsed["handled"])).toBe(true);
    expect(typeof parsed["deadlines"]).toBe("object");
  });

  // ---------------------------------------------------------------------------
  // Parent directory created lazily (state path under a non-existent subdir)
  // ---------------------------------------------------------------------------

  it("creates parent directory lazily if it does not exist", async () => {
    const nested = path.join(sandbox, "subdir", "nested", "queue-state.json");
    const nestedStore = new FileQueueStore(nested);
    await nestedStore.markHandled("item-nested");
    const result = await nestedStore.getHandled();
    expect(result.has("item-nested")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // State writes are confined to DATA_ROOT (raw-atomicWrite bypass closed)
  // ---------------------------------------------------------------------------

  it("REFUSES to write state outside DATA_ROOT", async () => {
    const elsewhere = mkdtempSync();
    try {
      const outsideStore = new FileQueueStore(
        path.join(elsewhere, "queue-state.json")
      );
      // DATA_ROOT is the sandbox; the store path is in a sibling tmpdir.
      await expect(outsideStore.markHandled("escape")).rejects.toThrow(
        /outside the data root|FND-03/
      );
    } finally {
      rmSync(elsewhere);
    }
  });

  it("REFUSES to write state when DATA_ROOT is unset", async () => {
    delete process.env["DATA_ROOT"];
    await expect(store.markHandled("no-root")).rejects.toThrow(
      /DATA_ROOT is required/
    );
  });
});
