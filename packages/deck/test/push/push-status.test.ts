import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import { action } from "~/routes/api.push-subscribe";
import { isSubscriptionSynced } from "~/lib/push.server";

const subscription = {
  endpoint: "https://push.example.com/device",
  keys: { p256dh: "device-key", auth: "device-auth" },
};

describe("push subscription status", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync();
    vi.stubEnv("DATA_ROOT", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root);
  });

  function writeKeys() {
    fs.writeFileSync(path.join(root, "vapid-keys.json"), JSON.stringify({
      publicKey: "current-public-key", privateKey: "test-private-key",
    }));
  }

  function writeStore() {
    fs.writeFileSync(path.join(root, "push-subscriptions.json"), JSON.stringify({
      version: 1, subscriptions: [{ ...subscription, addedAt: "2026-01-01T00:00:00Z" }],
    }));
  }

  async function status(applicationServerKey: string | null = "current-public-key") {
    return action({ request: new Request("http://localhost/api/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "status", subscription, applicationServerKey }),
    }) } as Parameters<typeof action>[0]);
  }

  it("confirms a stored subscription and current browser key", async () => {
    writeKeys();
    writeStore();
    const before = fs.readdirSync(root).map((name) => fs.readFileSync(path.join(root, name), "utf8"));
    const response = await status();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, synced: true });
    expect(fs.readdirSync(root).map((name) => fs.readFileSync(path.join(root, name), "utf8"))).toEqual(before);
  });

  it("does not provision missing keys or a missing store", async () => {
    expect(await (await status()).json()).toEqual({ ok: true, synced: false });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("rejects a missing or corrupt subscription store", () => {
    writeKeys();
    expect(isSubscriptionSynced(subscription, "current-public-key")).toBe(false);
    fs.writeFileSync(path.join(root, "push-subscriptions.json"), "invalid");
    expect(isSubscriptionSynced(subscription, "current-public-key")).toBe(false);
  });

  it("rejects a rotated or unknown browser key", async () => {
    writeKeys();
    writeStore();
    expect(await (await status("old-public-key")).json()).toEqual({ ok: true, synced: false });
    expect(await (await status(null)).json()).toEqual({ ok: true, synced: false });
  });

  it.each([
    { ...subscription, endpoint: "https://push.example.com/other" },
    { ...subscription, keys: { ...subscription.keys, p256dh: "other-key" } },
    { ...subscription, keys: { ...subscription.keys, auth: "other-auth" } },
  ])("requires endpoint and both encryption keys to match: %j", (candidate) => {
    writeKeys();
    writeStore();
    expect(isSubscriptionSynced(candidate, "current-public-key")).toBe(false);
  });

  it("rejects invalid status input", async () => {
    const response = await status("");
    expect(response.status).toBe(400);
  });
});
