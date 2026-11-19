#!/usr/bin/env node
/**
 * capture-readme-screenshots.mjs - retake the README screenshots in docs/images/
 * from the demo sandbox.
 *
 * 1. Start the sandbox from packages/deck. HOME points at the throwaway
 *    .runtime dir so the code preview can open a "~/" path without showing a
 *    real home directory (attachments render as Markdown; only "~/" or "/"
 *    paths get the highlighted code view):
 *
 *      cd packages/deck
 *      HOME="$PWD/.runtime" PATH="$PWD/node_modules/.bin:$PATH" \
 *        VOICE_PROXY_PORT=4262 node scripts/dev.mjs --port 4261
 *
 * 2. From the repo root:
 *      node scripts/capture-readme-screenshots.mjs
 *
 * Env:
 *   DECK_URL     base URL of the sandbox (default http://localhost:4261)
 *   CHROME_PATH  optional browser binary, when Playwright's own Chromium is not
 *                installed (e.g. /usr/bin/chromium-browser)
 *   SHOTS        optional comma-separated subset of shot names to retake
 *
 * The sandbox pins MC_NOW, so relative times ("in about 5 hours") are stable.
 * ASCII only - no em-dashes.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Playwright is a dev dependency of packages/deck, not of the workspace root.
const require = createRequire(path.join(repoRoot, "packages/deck/package.json"));
const { chromium } = require("@playwright/test");

const base = (process.env.DECK_URL || "http://localhost:4261").replace(/\/$/, "");
const outDir = path.join(repoRoot, "docs/images");
const doc = (p) => "doc=" + encodeURIComponent(p);

/**
 * name -> viewport, route, and optional layout:
 *   sidebarPx  drag the sidebar split to this x position
 *   reviewPx   review panel width (its persisted localStorage value)
 *   threadScroll  wheel delta applied over the thread before the shot
 */
const SHOTS = {
  "needs-you": { w: 1440, h: 1264, url: "/" },
  "agent-thread": { w: 1440, h: 1180, url: "/threads/scribe", threadScroll: -128 },
  "agent-thread-tech": { w: 1440, h: 1180, url: "/threads/atlas", threadScroll: -15 },
  "review-panel": {
    w: 1440,
    h: 900,
    url: "/threads/echo?files=1&" + doc("/attachments/echo/mc/spring-hero-a.png"),
    sidebarPx: 215,
    reviewPx: 520,
  },
  "code-preview": {
    w: 1440,
    h: 900,
    url: "/threads/atlas?" + doc("~/attachments/atlas/mc/spark-relay-launch.json"),
    sidebarPx: 215,
    reviewPx: 680,
    threadScroll: -70,
  },
  "project-board": { w: 1920, h: 820, url: "/projects", sidebarPx: 290 },
};

const only = process.env.SHOTS ? new Set(process.env.SHOTS.split(",")) : null;
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
try {
  for (const [name, s] of Object.entries(SHOTS)) {
    if (only && !only.has(name)) continue;
    const context = await browser.newContext({
      viewport: { width: s.w, height: s.h },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    if (s.reviewPx) {
      await context.addInitScript((px) => {
        try {
          localStorage.setItem("mc.reviewPanel.width", String(px));
        } catch {}
      }, s.reviewPx);
    }
    const page = await context.newPage();
    await page.goto(base + s.url, { waitUntil: "load" });
    // Some panels poll, so networkidle may never arrive: best effort only.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    if (s.sidebarPx) {
      const box = await page.locator('[role="separator"]').first().boundingBox();
      if (box) {
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(s.sidebarPx, y, { steps: 10 });
        await page.mouse.up();
        await page.mouse.move(s.w - 5, s.h - 5);
      }
    }
    if (s.threadScroll) {
      // Nudge the thread (left of the review panel) so no bubble is cut off.
      await page.mouse.move((s.sidebarPx ?? 320) + 120, 400);
      await page.mouse.wheel(0, s.threadScroll);
      await page.mouse.move(s.w - 5, s.h - 5);
    }
    // Let images decode and the thread settle at its scroll position.
    await page.evaluate(async () => {
      await document.fonts.ready;
      const pending = [...document.images].filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.map((img) => img.decode().catch(() => null))),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    });
    await page.waitForTimeout(1200);
    const file = path.join(outDir, name + ".png");
    await page.screenshot({ path: file });
    console.log("wrote", path.relative(repoRoot, file));
    await context.close();
  }
} finally {
  await browser.close();
}
