/**
 * push-store.test.ts - VAPID self-provision + subscription store.
 *
 * Proves:
 *   1. getVapidKeys generates + persists a keypair on first call.
 *   2. A second call returns the SAME pair (no key churn - churn would
 *      orphan every existing subscription).
 *   3. add/list round-trip; dedupe by endpoint (re-subscribe refreshes).
 *   4. removeSubscription drops only the named endpoint.
 *   5. Corrupt store file degrades to empty (tolerate-on-read).
 *
 * All writes are confined to a tmpdir DATA_ROOT.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import {
  getVapidKeys,
  addSubscription,
  listSubscriptions,
  removeSubscription,
} from "~/lib/push.server.js";

const SUB_A = {
  endpoint: "https://push.example.com/sub/aaa",
  keys: { p256dh: "key-a", auth: "auth-a" },
};
const SUB_B = {
  endpoint: "https://push.example.com/sub/bbb",
  keys: { p256dh: "key-b", auth: "auth-b" },
};

describe("push.server - VAPID + subscription store", () => {
  let sandbox: string;
  let savedDataRoot: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync();
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

  it("self-provisions a keypair and returns the same one thereafter", () => {
    const first = getVapidKeys();
    expect(first.publicKey.length).toBeGreaterThan(20);
    expect(first.privateKey.length).toBeGreaterThan(20);
    const second = getVapidKeys();
    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(sandbox, "vapid-keys.json"))).toBe(true);
  });

  it("add + list round-trip, deduped by endpoint", () => {
    addSubscription(SUB_A, "iPhone Safari");
    addSubscription(SUB_B);
    addSubscription({ ...SUB_A, keys: { p256dh: "key-a2", auth: "auth-a2" } });
    const subs = listSubscriptions();
    expect(subs).toHaveLength(2);
    const a = subs.find((s) => s.endpoint === SUB_A.endpoint);
    expect(a?.keys.p256dh).toBe("key-a2"); // refreshed, not duplicated
  });

  it("removeSubscription drops only the named endpoint", () => {
    addSubscription(SUB_A);
    addSubscription(SUB_B);
    removeSubscription(SUB_A.endpoint);
    const subs = listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.endpoint).toBe(SUB_B.endpoint);
  });

  it("corrupt store file degrades to empty", () => {
    fs.writeFileSync(
      path.join(sandbox, "push-subscriptions.json"),
      "{not json"
    );
    expect(listSubscriptions()).toEqual([]);
  });
});
