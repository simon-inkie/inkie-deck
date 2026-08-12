/**
 * malformed-block.test.ts - TASK-435.1 regression.
 *
 * A block whose header has no parseable timestamp (e.g. a headerless first
 * line like "## 14 open questions for Alex") makes blocks/parse.ts fall
 * back to timestamp:"". Before the time.ts guard, the formatters threw
 * "RangeError: Invalid time value" and crashed the WHOLE ThreadView - a
 * single bad block took down the thread.
 *
 * This is the level the time unit tests could not reach: they assert the
 * formatters in isolation (all passing), but the crash only appears when a
 * real malformed block flows parse -> time -> render. Assert the OUTCOME the
 * user experiences (the thread renders), not the proxy (the formatter works
 * on valid input). The proxy is not a weaker version of the outcome here,
 * it is a different claim: the formatters' unit suite was green throughout,
 * and this bug shipped behind it.
 *
 * VALID-03: writes only to the temp INBOX_ROOT, never committed fixtures.
 * ASCII only - no em-dashes (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("TASK-435.1: a malformed-timestamp block renders the thread without crashing", async ({
  page,
}) => {
  // Prepend a malformed block (header with NO timestamp) to the temp fixture -
  // the exact shape that crashed Alex's dev tree (the old "14 open questions"
  // header). parse.ts -> timestamp:"" -> the formatters must tolerate it.
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const malformed = [
    "## 14 open questions for Alex",
    "",
    "This block has no parseable timestamp and must not crash the thread.",
    "",
    "---",
    "",
  ].join("\n");
  const existing = fs.readFileSync(inboxFile, "utf8");
  fs.writeFileSync(inboxFile, malformed + existing, "utf8");

  // Capture any uncaught page error (a RangeError would surface here).
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/threads/scribe");

  // The thread renders: header present, the malformed block's body visible,
  // AND the normal blocks below it still render (the bad block did not abort).
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
  await expect(
    page.getByRole("main").getByText("This block has no parseable timestamp", {
      exact: false,
    })
  ).toBeVisible();
  await expect(page.getByPlaceholder("Write a reply...")).toBeVisible();

  // No uncaught RangeError (or anything else) reached the page.
  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});

test("2026-06-11 P1 regression: an em-dash-delimited DECISION card crashes neither home nor thread", async ({
  page,
}) => {
  // The exact production shape that took MC down: header fields separated by
  // em-dashes (U+2014, built via charCode so this file stays check:dashes
  // clean) carrying a decision card. Pre-fix: parseHeader failed, timestamp
  // fell back to "", deriveNeedsYou threw Invalid time value, EVERY page 500'd.
  const D = String.fromCharCode(0x2014);
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const block = [
    `## 2026-06-11T12:08:00Z ${D} from: scribe ${D} status: sent ${D} subject: em-dash card regression`,
    "decision-id: EMDASH-REGRESSION",
    "options:",
    '  - key: A',
    '    label: "Option A"',
    '    detail: "first"',
    '  - key: B',
    '    label: "Option B"',
    '    detail: "second"',
    "",
    "Body of the em-dash card regression block.",
    "",
    "---",
    "",
  ].join("\n");
  const existing = fs.readFileSync(inboxFile, "utf8");
  fs.writeFileSync(inboxFile, existing + block, "utf8");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Home (the queue loader - the surface that died in production).
  const homeResp = await page.goto("/");
  expect(homeResp!.status()).toBe(200);

  // Thread still renders, and with the tolerant parser the card is FUNCTIONAL.
  const threadResp = await page.goto("/threads/scribe");
  expect(threadResp!.status()).toBe(200);
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
  await expect(
    page.getByText("em-dash card regression", { exact: false }).first()
  ).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});

test("2026-06-11 hardening: an ACTION card with a garbage timestamp crashes neither home nor thread", async ({
  page,
}) => {
  // ActionCard used to call formatDistance(new Date(header.timestamp)) raw on
  // the client - a malformed timestamp on an action card killed the whole
  // page render. Build a block whose header parses EXCEPT the timestamp is
  // garbage... parseHeader rejects non-dates, so the realistic shape is a
  // headerless action block (timestamp falls back to ""), same as production.
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const block = [
    "## bad-action-header-no-timestamp",
    "action-id: garbage-ts-action",
    "",
    "Action body with an unparseable header timestamp.",
    "",
    "---",
    "",
  ].join("\n");
  const existing = fs.readFileSync(inboxFile, "utf8");
  fs.writeFileSync(inboxFile, existing + block, "utf8");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const homeResp = await page.goto("/");
  expect(homeResp!.status()).toBe(200);

  const threadResp = await page.goto("/threads/scribe");
  expect(threadResp!.status()).toBe(200);
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});
