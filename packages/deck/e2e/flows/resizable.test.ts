/**
 * resizable.test.ts - resizable sidebar / thread split.
 *
 * Covers: drag grows the sidebar, the split persists across reload
 * (library autoSaveId -> localStorage), and the phone layout never sees
 * the handle (display:none removes it from flex layout entirely).
 *
 * ASCII only - no em-dashes.
 */
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

test("TASK-456: dragging the handle resizes the sidebar and persists across reload", async ({
  page,
}) => {
  await page.goto("/");

  // Hydration swaps the SSR DOM and the panel library lays out on mount -
  // a bare boundingBox() can catch the swap mid-flight and return null.
  // Poll until the layout has settled to a real box.
  const sidebar = page.locator("nav");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeGreaterThan(50);
  const before = (await sidebar.boundingBox())!;

  // Drag the separator 140px right.
  const handle = page.getByRole("separator").first();
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 140, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width + 60);
  const after = (await sidebar.boundingBox())!;

  // The library's autoSave write is debounced AND an initial save fires on
  // page load with the default layout - so "key exists" is not enough; the
  // reload can still beat the post-drag save. Wait until the STORED layout
  // actually reflects the drag (first panel above its 22 default).
  await page.waitForFunction(
    () => {
      const key = Object.keys(localStorage).find((k) =>
        k.includes("mc-shell-split")
      );
      if (!key) return false;
      const raw = localStorage.getItem(key) ?? "";
      const layouts = Object.values(JSON.parse(raw)) as Array<{
        layout?: number[];
      }>;
      return layouts.some((l) => (l.layout?.[0] ?? 0) > 25);
    },
    undefined,
    { timeout: 5_000 }
  );

  // Reload: the dragged split persists. Poll INTO the dragged width - the
  // first paint renders the SSR default before the saved layout applies.
  await page.reload();
  await expect
    .poll(async () => (await page.locator("nav").boundingBox())?.width ?? 0)
    .toBeGreaterThan(after.width - 12);
});

test("TASK-456: phone layout has no handle; agent strip stays the nav", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("separator")).not.toBeVisible();
  await expect(page.getByTestId("agent-strip")).toBeVisible();
});
