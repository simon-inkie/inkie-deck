/**
 * dictated-marker.test.ts - a block carrying the "dictated: true" meta line
 * renders the mic + "dictated" provenance marker in its bubble footer
 * (2026-06-11, Alex: "header so you know it's dictated").
 *
 * VALID-03: writes only under INBOX_ROOT (temp). ASCII only (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("a dictated block shows the mic marker; a typed one does not", async ({ page }) => {
  resetFixtureInbox();
  const inboxRoot = process.env["INBOX_ROOT"];
  const dir = path.join(inboxRoot!, "scribe", "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "alex.md"),
    [
      `## 2026-06-11T20:00:00Z - from: scribe - status: read - subject: typed message`,
      ``,
      `A plain typed message.`,
      ``,
      `---`,
      `## 2026-06-11T20:05:00Z - from: alex - status: read - subject: Re: typed message`,
      `dictated: true`,
      ``,
      `This reply was dictated and might be a bit wonky.`,
      ``,
      `---`,
      ``,
    ].join("\n"),
    "utf8"
  );

  await page.goto("/threads/scribe");

  // The dictated reply shows the marker.
  const marker = page.getByTestId("bubble-dictated");
  await expect(marker).toBeVisible();
  await expect(marker).toContainText("dictated");

  // Exactly one marker on the page - the typed block carries none.
  await expect(marker).toHaveCount(1);
});
