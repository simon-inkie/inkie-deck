/**
 * card-reply-cross-route.test.ts - answering a card in your own words from the
 * CARDS TAB must arrive on the thread page still knowing which card you meant.
 *
 * THE BUG. "OR write something..." on a card rendered INLINE in its own thread
 * works, because handleWriteOwn lifts state on an already-mounted component.
 * The same button on the Cards tab could not: /cards and /threads/<agent> are
 * different route modules, so the click is a genuine cross-route navigation and
 * the thread component mounts FRESH with respondingToDecisionId back at
 * undefined. Only ?anchor survived, and nothing read it for anything but
 * scrolling. The user landed on the thread with an ORDINARY composer, typed
 * their answer, and it went out as a plain chat message: no "answered: custom" on
 * the card, no "answer: custom" receipt block, and the card still sitting open.
 *
 * THE LOAD-BEARING DETAIL IN TEST 1: it CLICKS the write-own button on /cards
 * rather than page.goto-ing the thread URL. The click is the whole bug - it is
 * what exercises the producer (the href cards.tsx builds) and the consumer (the
 * seeding effect in threads.$agent.tsx) against each other. A test that typed
 * the URL by hand would still pass if cards.tsx sent the wrong link.
 *
 * page.goto IS used in the validation tests below, and legitimately so: there
 * the URL is the entire input under test (a stale or hand-edited seed), so
 * arriving by full document load is the honest reproduction.
 *
 * The discriminating assertion throughout is the WRITEBACK, not the UI: a card
 * answer writes "answered: custom" onto the card and an "answer: custom" reply block. A
 * plain chat reply - the bug - writes neither. The two are indistinguishable on
 * screen for a moment and never indistinguishable on disk.
 *
 * Named for the outcome rather than the scenario, so the assertions cannot be
 * inverted without the names going obviously wrong.
 *
 * Writeback goes to INBOX_ROOT (temp dir), never committed fixtures.
 * ASCII only - no em-dashes.
 */
import { test, expect, type Page } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

/** The one open decision card in fixtures/inbox (scribe). */
const CARD_ID = "TASK-413-q1";
const CARD_AGENT = "scribe";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

/** The composer's card-reply banner. Present only in card-reply mode. */
function replyBanner(page: Page) {
  return page.getByTestId("responding-to-banner");
}

function inboxContent(agent: string): string {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set - globalSetup did not run");
  return fs.readFileSync(
    path.join(inboxRoot, agent, "inbox", "alex.md"),
    "utf8"
  );
}

/** The reply-seed param must be spent, and the loader's window cursor must not
 *  be collateral damage of spending it. */
function urlParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

/**
 * Cards tab -> "OR write something..." on the single open decision card.
 * Asserts the navigation actually happened, so a mis-targeted click fails here
 * rather than silently turning the test into a no-op that "passes".
 */
async function writeOwnFromCardsTab(page: Page): Promise<void> {
  await page.goto("/cards");
  const card = page
    .getByTestId("cards-section-decisions")
    .locator('[data-testid="decision-card"]')
    .first();
  await expect(card).toBeVisible();
  await card.getByTestId("write-own-btn").click();
  await expect(page).toHaveURL(new RegExp(`/threads/${CARD_AGENT}`));
}

// ---------------------------------------------------------------------------
// (a) The fix: the reply context survives the cross-route navigation.
// ---------------------------------------------------------------------------

test("a card answered from the Cards tab is tied to that card, not sent as chat", async ({
  page,
}) => {
  await writeOwnFromCardsTab(page);

  // Landed in card-reply mode, naming the card - not an ordinary composer.
  await expect(replyBanner(page)).toBeVisible({ timeout: 10_000 });
  await expect(replyBanner(page)).toContainText("ad spend decision");

  const answer = "Split it - 60/day for the fair week only, marker 4q8w";
  const textarea = page.getByTestId("compose-textarea");
  await textarea.fill(answer);
  await textarea.press("Enter");

  // The card resolves rather than staying open behind a new chat message.
  const chip = page
    .locator('[data-testid="decision-card"]')
    .first()
    .getByTestId("decision-resolution-chip");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText("Answered:");

  // The writeback is the real proof. Under the bug this file gained a plain
  // reply block and the card kept no answer at all.
  const content = inboxContent(CARD_AGENT);
  expect(content).toContain("answered: custom");
  expect(content).toContain("answer: custom");
  expect(content).toContain(answer);
});

// ---------------------------------------------------------------------------
// (b) The seed is validated, not trusted.
// ---------------------------------------------------------------------------

test("an unknown decision id in the URL leaves the composer ordinary", async ({
  page,
}) => {
  const bogus = "TASK-000-no-such-card";
  await page.goto(
    `/threads/${CARD_AGENT}?anchor=${bogus}&reply=${bogus}#${bogus}`
  );

  await expect(page.getByTestId("compose-textarea")).toBeVisible();
  // No card matches, so nothing may force reply mode.
  await expect(replyBanner(page)).toHaveCount(0);
});

test("an already-answered card in the URL leaves the composer ordinary", async ({
  page,
}) => {
  // Close the card first, the way a second tab or a colleague would have.
  await page.goto(`/threads/${CARD_AGENT}`);
  await page
    .getByRole("button", { name: /Hold spend at/ })
    .click();
  await expect(
    page.locator('[data-testid="decision-card"]').first().getByTestId("decision-resolution-chip")
  ).toBeVisible({ timeout: 10_000 });

  // Now follow a reply link that was minted while the card was still open.
  await page.goto(
    `/threads/${CARD_AGENT}?anchor=${CARD_ID}&reply=${CARD_ID}#${CARD_ID}`
  );
  await expect(page.getByTestId("compose-textarea")).toBeVisible();
  await expect(replyBanner(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// (c) Consume once: the seed must not keep dragging the user back.
// ---------------------------------------------------------------------------

test("cancelling a seeded card reply stays cancelled, through a reload", async ({
  page,
}) => {
  await writeOwnFromCardsTab(page);
  await expect(replyBanner(page)).toBeVisible({ timeout: 10_000 });

  // The seed is spent the moment it is read; the loader's window cursor is not.
  await expect
    .poll(() => urlParams(page).get("reply"), { timeout: 5_000 })
    .toBeNull();
  expect(urlParams(page).get("anchor")).toBe(CARD_ID);

  // Cancel out of reply mode, and it must STAY cancelled. Before the seed was
  // consume-once this is where it would snap straight back.
  await page.getByLabel("Cancel responding").click();
  await expect(replyBanner(page)).toHaveCount(0);

  // A reload re-reads the URL from scratch. A seed left in it would re-fire.
  await page.reload();
  await expect(page.getByTestId("compose-textarea")).toBeVisible();
  await expect(replyBanner(page)).toHaveCount(0);
});

test("a seeded card reply does not follow an unrelated navigation back", async ({
  page,
}) => {
  await writeOwnFromCardsTab(page);
  await expect(replyBanner(page)).toBeVisible({ timeout: 10_000 });

  // Leave the thread entirely, then come back by an ordinary route with no
  // reply param on it.
  // Scoped to the header: the mobile agent strip carries a second "Cards" link
  // (display:none at this viewport, but the scope makes the intent explicit).
  await page.locator("header").getByRole("link", { name: "Cards" }).click();
  await expect(page).toHaveURL(/\/cards$/);
  await page
    .locator("nav")
    .getByRole("link", { name: new RegExp(`^${CARD_AGENT}`, "i") })
    .click();
  await expect(page).toHaveURL(new RegExp(`/threads/${CARD_AGENT}$`));

  // Ordinary composer. Reply mode was a property of that one seeded arrival.
  await expect(page.getByTestId("compose-textarea")).toBeVisible();
  await expect(replyBanner(page)).toHaveCount(0);
});
