/**
 * avatars.test.ts - real avatars with initials fallback.
 *
 * Drops a tiny PNG into the TEMP fixture inbox root (tmpdir-only)
 * and asserts the serving route + the render chain + the fallback.
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

function seedAvatar(agent: string): void {
  const inboxRoot = process.env["INBOX_ROOT"];
  const file = path.join(inboxRoot!, agent, "avatar.png");
  fs.writeFileSync(file, TINY_PNG);
}

test("TASK-457: avatar.png renders in the sidebar; agents without stay initials", async ({
  page,
}) => {
  seedAvatar("scribe");
  await page.goto("/");

  // scribe row shows the real image...
  const sidebar = page.locator("nav");
  await expect(
    sidebar.getByRole("link", { name: /scribe/i }).getByTestId("avatar-image")
  ).toBeVisible({ timeout: 5_000 });

  // ...while an avatar-less agent keeps the initials disc (no img element).
  await expect(
    sidebar.getByRole("link", { name: /^quill/i }).getByTestId("avatar-image")
  ).not.toBeVisible();
});

test("TASK-457: serving route returns PNG bytes with immutable caching", async ({
  page,
}) => {
  seedAvatar("scribe");

  const response = await page.request.get("/avatars/scribe");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(response.headers()["cache-control"]).toContain("immutable");
  const body = await response.body();
  expect(body.length).toBe(TINY_PNG.length);
});

test("TASK-457: traversal-shaped and absent-agent requests 404 with no detail", async ({
  page,
}) => {
  seedAvatar("scribe");

  for (const bad of ["/avatars/..%2Fscribe", "/avatars/SCRIBE", "/avatars/ghost"]) {
    const response = await page.request.get(bad);
    expect(response.status(), bad).toBe(404);
    expect((await response.body()).length, bad).toBe(0);
  }
});

test("TASK-457: thread bubbles carry the sender's face; app-bar identity uses it too", async ({
  page,
}) => {
  seedAvatar("scribe");
  await page.goto("/threads/scribe");

  // App-bar identity renders the image.
  await expect(
    page.locator("header").getByTestId("avatar-image")
  ).toBeVisible({ timeout: 5_000 });

  // At least one agent bubble in the thread shows the face.
  await expect(
    page.getByRole("main").getByTestId("avatar-image").first()
  ).toBeVisible();
});
