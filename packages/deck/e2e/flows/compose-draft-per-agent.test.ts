/**
 * compose-draft-per-agent.test.ts - per-agent compose draft persistence
 * (2026-06-12 Alex report).
 *
 * The Compose box is reused across thread navigation, so a single draft state
 * leaked across agents: text typed for one agent showed up in another, and was
 * lost from the first. Drafts are now namespaced per agent in sessionStorage.
 *
 * This test navigates CLIENT-SIDE (sidebar link clicks, not page.goto) to
 * exercise the exact reuse path the bug lived in.
 *
 * VALID-03: read-only on fixtures (no compose submit). ASCII only (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("a draft is retained per agent across thread navigation", async ({ page }) => {
  const textarea = page.locator('[data-testid="compose-textarea"]');

  // Open scribe and type a draft (do NOT send).
  await page.goto("/threads/scribe");
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
  await textarea.fill("draft meant for scribe only");

  // Navigate client-side to quill: its compose must be empty, not show scribe'
  // text (this is the leak the bug caused).
  await page.getByRole("navigation").getByRole("link", { name: /^quill/i }).click();
  await expect(page.getByTestId("thread-header")).toContainText("quill");
  await expect(textarea).toHaveValue("");

  // Type a different draft for quill.
  await textarea.fill("a separate draft for quill");

  // Back to scribe client-side: its own draft is restored.
  await page.getByRole("navigation").getByRole("link", { name: /^scribe/i }).click();
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
  await expect(textarea).toHaveValue("draft meant for scribe only");

  // And quill still holds its own.
  await page.getByRole("navigation").getByRole("link", { name: /^quill/i }).click();
  await expect(page.getByTestId("thread-header")).toContainText("quill");
  await expect(textarea).toHaveValue("a separate draft for quill");
});
