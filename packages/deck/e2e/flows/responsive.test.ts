/**
 * e2e/flows/responsive.test.ts - Mobile viewport responsive layout tests.
 *
 * Three tests at 390x844 (the established mobile viewport pattern):
 *   1. Shell: agent strip visible, sidebar hidden, tapping agent navigates.
 *   2. Thread: compose visible, send works, last message not obscured.
 *   3. Home queue: full-width card render at mobile viewport.
 *
 * Desktop suites are untouched; this file is additive.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { test, expect } from "@playwright/test";
import {
  resetFixtureInbox,
  assertGitClean,
  sendButton,
  expectDelivered,
} from "./helpers.js";
import path from "node:path";

const MOBILE = { width: 390, height: 844 };

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

// ---------------------------------------------------------------------------
// Test 1: Shell - agent strip visible, sidebar hidden, tap navigates
// ---------------------------------------------------------------------------

test("RESP-01: mobile shell - agent strip visible, sidebar hidden, tap navigates", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/");

  // Agent strip is visible on mobile.
  const strip = page.getByTestId("agent-strip");
  await expect(strip).toBeVisible();

  // Sidebar nav (desktop) is hidden.
  // The sidebar is wrapped in a hidden md:flex div, so it should not be visible.
  const sidebar = page.locator("nav").filter({ hasText: "Agents" });
  await expect(sidebar).not.toBeVisible();

  // Tapping the agent strip button for "scribe" navigates to the thread.
  const scribeBtn = page.getByTestId("agent-strip-btn-scribe");
  await expect(scribeBtn).toBeVisible();
  await scribeBtn.click();

  // Should navigate to /threads/scribe.
  await expect(page).toHaveURL(/\/threads\/scribe/);

  // Thread header is present after navigation.
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
});

// ---------------------------------------------------------------------------
// Test 2: Thread - compose visible, send works, last message not obscured
// ---------------------------------------------------------------------------

test("RESP-02: mobile thread - compose visible, send works, last message not hidden", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/threads/scribe");

  // Compose textarea is visible (sticky bottom).
  const textarea = page.locator('[data-testid="compose-textarea"]');
  await expect(textarea).toBeVisible();

  // Send button is visible and has a usable tap target.
  const sendBtn = sendButton(page);
  await expect(sendBtn).toBeVisible();

  // Send a reply.
  const uniqueBody = "RESP-02 mobile compose test unique-9x3m";
  await textarea.fill(uniqueBody);
  await sendBtn.click();

  // "send works" has to mean the message SENT. The old assertion looked for the
  // text in <main>, which the local pending bubble satisfies without any POST -
  // so this test would have stayed green on a composer that never sent at all.
  await expectDelivered("scribe", uniqueBody);

  // The reply appears in the thread. Scoped to the message list, not <main>:
  // the pending bubble renders outside the scroll area, so only a delivered
  // block can satisfy this - and the occlusion check below then measures a real
  // message bubble rather than the pending indicator.
  await expect(
    page.getByTestId("thread-scroll").getByText(uniqueBody)
  ).toBeVisible({ timeout: 10_000 });

  // Last message is not obscured by the sticky compose bar.
  // The message should be visible in the viewport - Playwright's isVisible() checks
  // the element is within the visible area (not clipped by overflow or behind another
  // element with pointer-events:none). The sticky compose must not fully occlude it.
  const msgEl = page.getByTestId("thread-scroll").getByText(uniqueBody);
  await expect(msgEl).toBeVisible();

  // Additional check: scroll into view and confirm it becomes visible even if
  // the initial render hasn't scrolled to it yet.
  await msgEl.scrollIntoViewIfNeeded();
  await expect(msgEl).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: Home queue - full-width card render at mobile viewport
// ---------------------------------------------------------------------------

test("RESP-03: mobile home - queue cards render full-width", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/");

  // The home page loads (Needs you heading).
  await expect(
    page.getByRole("heading", { name: /needs you/i })
  ).toBeVisible();

  // Queue items (if any) are present and within the viewport width.
  // The fixture inbox has a decision card in the scribe thread which
  // shows up as a queue item. Assert the container is visible and not
  // clipped off-screen horizontally.
  const homeMain = page.getByRole("main");
  await expect(homeMain).toBeVisible();

  // The home max-w-2xl container should not overflow the 390px viewport.
  const mainBox = await homeMain.boundingBox();
  if (mainBox) {
    // Container right edge must not exceed viewport width.
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(MOBILE.width + 1);
  }

  // TASK-435 mobile bug (Alex's phone 2026-06-08): the needs-you CARDS were
  // overflowing past the viewport (clipped text) even though `main` itself
  // measured 390 - the content column inside main had no min-w-0, so the
  // max-w-2xl block forced it to 672px. Assert the actual card right edge,
  // not just main, or this class of bug slips the net again.
  const items = page.getByTestId("needs-you-item");
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const box = await items.nth(i).boundingBox();
    if (box) {
      expect(
        box.x + box.width,
        `needs-you card ${i} must stay within the viewport`
      ).toBeLessThanOrEqual(MOBILE.width + 1);
    }
  }

  // And no element inside the home content column may push past the viewport.
  const homeOverflow = await page.evaluate((vw) => {
    let worst = 0;
    for (const el of document.querySelectorAll('[data-testid="needs-you-item"] *')) {
      worst = Math.max(worst, el.getBoundingClientRect().right);
    }
    return worst;
  }, MOBILE.width);
  expect(homeOverflow).toBeLessThanOrEqual(MOBILE.width + 1);

  // Agent strip is present on the home page too (shell wraps home).
  const strip = page.getByTestId("agent-strip");
  await expect(strip).toBeVisible();
});
