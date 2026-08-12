/**
 * push.test.ts - TASK-470 web push surfaces.
 *
 * Proves:
 *   1. The PWA shell is served: /sw.js + /manifest.webmanifest + icons 200.
 *   2. /api/push-subscribe GET self-provisions and returns a VAPID public key
 *      (stable across calls - key churn would orphan subscriptions).
 *   3. POST subscribe stores the subscription (tmp DATA_ROOT per VALID-03);
 *      POST unsubscribe removes it; malformed bodies 400.
 *   4. The bell dropdown renders the enable-notifications affordance.
 *
 * Actual push delivery is a documented manual step (live browser + phone),
 * not e2e - the watcher's logic is unit-tested in test/push/.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterAll(() => assertGitClean(path.resolve(".")));

test("PWA shell assets are served", async ({ request }) => {
  for (const url of [
    "/sw.js",
    "/manifest.webmanifest",
    "/icons/mc-192.png",
    "/icons/mc-512.png",
    "/icons/apple-touch-icon.png",
  ]) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(200);
  }
});

test("GET push-subscribe returns a stable VAPID public key", async ({ request }) => {
  const first = (await (await request.get("/api/push-subscribe")).json()) as {
    ok: boolean;
    publicKey: string;
  };
  expect(first.ok).toBe(true);
  expect(first.publicKey.length).toBeGreaterThan(20);
  const second = (await (await request.get("/api/push-subscribe")).json()) as {
    publicKey: string;
  };
  expect(second.publicKey).toBe(first.publicKey);
});

test("subscribe / unsubscribe round-trip persists to the store", async ({ request }) => {
  const sub = {
    endpoint: "https://push.example.com/e2e/round-trip",
    keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" },
  };
  const add = await request.post("/api/push-subscribe", {
    data: { intent: "subscribe", subscription: sub },
  });
  expect(add.status()).toBe(200);

  const dataRoot = process.env["DATA_ROOT"];
  const storeFile = path.join(dataRoot!, "push-subscriptions.json");
  const stored = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
    subscriptions: Array<{ endpoint: string }>;
  };
  expect(stored.subscriptions.some((s) => s.endpoint === sub.endpoint)).toBe(true);

  const remove = await request.post("/api/push-subscribe", {
    data: { intent: "unsubscribe", endpoint: sub.endpoint },
  });
  expect(remove.status()).toBe(200);
  const after = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
    subscriptions: Array<{ endpoint: string }>;
  };
  expect(after.subscriptions.some((s) => s.endpoint === sub.endpoint)).toBe(false);
});

test("malformed subscribe body is a 400, not a 500", async ({ request }) => {
  const res = await request.post("/api/push-subscribe", {
    data: { intent: "subscribe", subscription: { endpoint: "not-a-url" } },
  });
  expect(res.status()).toBe(400);
});

test("bell dropdown offers enable-notifications", async ({ page }) => {
  resetFixtureInbox();
  await page.goto("/");
  await page.getByRole("button", { name: /Needs you/ }).click();
  const toggle = page.getByTestId("push-toggle");
  await expect(toggle).toBeVisible();
});
