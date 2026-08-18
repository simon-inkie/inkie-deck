/**
 * escalation-header.test.ts - the top bar survives a visible escalation reason
 * on a phone (TASK-783).
 *
 * WHAT WENT WRONG, measured rather than reasoned about. Replacing the bare
 * TriangleAlert with an icon-plus-text chip ("quill stuck for 45m") took the
 * header's right-hand cluster from 132px to 264px. The left group carries
 * `min-w-0`, so its BOX shrank as intended, but the avatar and the
 * chat/terminal toggle inside it are `shrink-0` and did not shrink with it:
 * they overflowed their box and were painted underneath the cluster to their
 * right. In Chromium against the real stylesheet, at 375px the toggle
 * overlapped the chip by 58px and the thread title was crushed to ZERO width;
 * at 320px the entire 78px toggle sat under the chip, and since the chip is
 * later in DOM order and paints on top, the toggle stopped taking taps at all.
 * A change about making an alert readable on a phone had made the phone header
 * worse, which is why this file exists and why it is a browser test: jsdom has
 * no CSS, so the unit suite cannot see any of it.
 *
 * WHY THESE ASSERTIONS. Bounding boxes alone are not enough, because
 * getBoundingClientRect reports the LAYOUT rect and ignores clipping by an
 * ancestor - two elements can report a clean overlap that the user cannot
 * click, and can report an overlap that is in fact clipped away. So the
 * load-bearing check here is a hit test: elementFromPoint at each control's
 * own centre must land inside that control. That is the property the bug
 * actually broke, stated directly.
 *
 * These run against the 3918 server (see playwright.config.ts), the only one
 * with an ACTIVITY_ROOT, whose committed fixture pins quill as stuck since
 * 45 minutes before MC_NOW.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { assertGitClean } from "../flows/helpers.js";

/** iPhone SE / iPhone 8, the narrowest width a reader is realistically on. */
const PHONE = { width: 375, height: 812 };
/** Narrower than any current phone: the margin, not the target. */
const NARROW = { width: 320, height: 812 };
/** Desktop, where the chip is meant to stay inline on one row. */
const DESKTOP = { width: 1280, height: 900 };

const THREAD = "/threads/quill";
const REASON = "quill stuck for 45m";

/** Controls that must remain visible and tappable at every width. */
const CONTROLS = [
  '[data-testid="escalation-alert"]',
  '[data-testid="escalation-reason"]',
  '[data-testid="thread-view-chat"]',
  '[data-testid="thread-view-tmux"]',
  '[aria-label="Toggle files panel"]',
  'button[aria-label^="Needs you"]',
];

test.afterAll(() => assertGitClean(path.resolve(".")));

/**
 * Hit test every control: the element at each one's centre point must be the
 * control itself or something inside it. Returns the failures, so a single
 * assertion can name all of them at once.
 */
async function occludedControls(page: Page): Promise<string[]> {
  return page.evaluate((selectors) => {
    const bad: string[] = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el === null) {
        bad.push(`${sel}: not rendered`);
        continue;
      }
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) {
        bad.push(`${sel}: collapsed to ${Math.round(b.width)}x${Math.round(b.height)}`);
        continue;
      }
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit === null || !(el.contains(hit) || hit.contains(el))) {
        const name =
          hit === null
            ? "nothing"
            : hit.tagName.toLowerCase() +
              (hit instanceof HTMLElement && hit.dataset["testid"]
                ? `[${hit.dataset["testid"]}]`
                : "") +
              (hit.getAttribute("aria-label") ? `"${hit.getAttribute("aria-label")}"` : "");
        bad.push(`${sel}: centre point belongs to ${name}`);
      }
    }
    return bad;
  }, CONTROLS);
}

/** Header geometry, in one round trip. */
async function headerBox(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector("header");
    if (header === null) throw new Error("no header");
    const groups = Array.from(header.children).map((c) => c.getBoundingClientRect());
    const reason = document.querySelector('[data-testid="escalation-reason"]');
    let worstRight = 0;
    for (const el of header.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      worstRight = Math.max(worstRight, b.right);
    }
    return {
      height: header.getBoundingClientRect().height,
      // Two flex children: the identity group and the control cluster.
      // `sameRow` compares edges rather than tops, because the two groups are
      // different heights (42px and 44px) and are centred against each other,
      // so on ONE row their tops differ by a pixel. Vertical overlap is the
      // honest test of "on the same line".
      leftTop: groups[0]?.top ?? 0,
      leftBottom: groups[0]?.bottom ?? 0,
      clusterTop: groups[1]?.top ?? 0,
      sameRow: (groups[1]?.top ?? 0) < (groups[0]?.bottom ?? 0),
      worstRight,
      docScrollWidth: document.documentElement.scrollWidth,
      // Truncation tell: a truncated node scrolls wider than it is.
      reasonClientWidth: reason?.clientWidth ?? 0,
      reasonScrollWidth: reason?.scrollWidth ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------

test("ESC-01: on a phone the escalation reason is whole and no control is covered", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(THREAD);
  await expect(page.getByTestId("escalation-reason")).toHaveText(REASON);

  // Nothing in the header sticks out past the viewport, and the page did not
  // gain a horizontal scrollbar to hide it in.
  const box = await headerBox(page);
  expect(box.worstRight, "no header element may extend past the viewport").toBeLessThanOrEqual(
    PHONE.width + 1
  );
  expect(box.docScrollWidth, "the page must not scroll sideways").toBeLessThanOrEqual(
    PHONE.width
  );

  // The reason text is complete, not ellipsised: the duration is the fact the
  // interruption gets priced with, so losing its tail would restate the bug
  // the visible reason fixed.
  expect(
    box.reasonScrollWidth,
    "the reason text must not be truncated"
  ).toBeLessThanOrEqual(box.reasonClientWidth + 1);

  // The load-bearing one. Every control answers to a tap at its own centre.
  expect(await occludedControls(page)).toEqual([]);

  // The thread title regressed to zero width, which is how the overlap was
  // first visible; it must survive as something.
  const title = await page.getByTestId("thread-header").boundingBox();
  expect(title?.width ?? 0, "the thread title must not be crushed to nothing").toBeGreaterThan(
    0
  );
});

test("ESC-02: the alert cluster takes its own row rather than overflowing", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(THREAD);
  await expect(page.getByTestId("escalation-reason")).toHaveText(REASON);

  const box = await headerBox(page);
  // Wrapped: the cluster starts at or below the identity group's bottom edge.
  expect(
    box.sameRow,
    "the control cluster must wrap onto its own row, not share the identity row"
  ).toBe(false);
  // And the bar grew to hold it instead of spilling over the content beneath.
  expect(box.height, "the header must grow to fit both rows").toBeGreaterThan(56);
});

test("ESC-03: 320px, narrower than any real phone, still clips nothing", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto(THREAD);
  await expect(page.getByTestId("escalation-reason")).toHaveText(REASON);

  const box = await headerBox(page);
  expect(box.worstRight).toBeLessThanOrEqual(NARROW.width + 1);
  expect(box.docScrollWidth).toBeLessThanOrEqual(NARROW.width);
  expect(box.reasonScrollWidth).toBeLessThanOrEqual(box.reasonClientWidth + 1);
  expect(await occludedControls(page)).toEqual([]);
});

test("ESC-04: on desktop the chip stays inline on a single 56px row", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(THREAD);
  await expect(page.getByTestId("escalation-reason")).toHaveText(REASON);

  const box = await headerBox(page);
  // The wrap is a narrow-viewport accommodation; the desktop bar is untouched.
  expect(box.sameRow, "one row on desktop").toBe(true);
  expect(box.height, "unchanged 56px bar on desktop").toBe(56);
  expect(await occludedControls(page)).toEqual([]);
});

test("ESC-05: with nothing escalated the phone header is one row, as before", async ({
  page,
}) => {
  // SPECIFICITY. ESC-01..03 prove the header copes WITH an escalation; they
  // would all still pass if the cluster had been made to wrap unconditionally,
  // which would cost every mobile thread view a second header row for nothing.
  // Point the same server at a document with no escalatable agent and the bar
  // must be exactly what it was before this feature.
  const activityRoot = process.env["LAYOUT_ACTIVITY_ROOT"];
  expect(activityRoot, "LAYOUT_ACTIVITY_ROOT not set - globalSetup did not run").toBeTruthy();
  const file = path.join(activityRoot!, "activity.json");
  const original = fs.readFileSync(file, "utf8");

  try {
    const doc = JSON.parse(original);
    doc.agents.quill.status = "working";
    fs.writeFileSync(file, JSON.stringify(doc), "utf8");

    await page.setViewportSize(PHONE);
    await page.goto(THREAD);
    await expect(page.getByTestId("escalation-alert")).toHaveCount(0);

    const box = await headerBox(page);
    expect(box.height, "no escalation, no second row").toBe(56);
    expect(box.sameRow, "no escalation, one row").toBe(true);
    expect(box.worstRight).toBeLessThanOrEqual(PHONE.width + 1);
    expect(await occludedControls(page).then((b) => b.filter((s) => !s.includes("escalation")))).toEqual(
      []
    );
  } finally {
    fs.writeFileSync(file, original, "utf8");
  }
});
