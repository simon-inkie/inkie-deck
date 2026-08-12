import { expect, test } from "@playwright/test";

// The one honest end-to-end test this slice can have: there is no UI yet, so
// the only claim worth checking is that the Playwright harness itself runs,
// launches a browser and can assert against a page. Anything more elaborate
// here would be coverage theatre. Real journeys arrive with the first UI.
test("the e2e harness launches a browser and asserts", async ({ page }) => {
  await page.setContent("<h1>inkie-deck e2e harness</h1>");
  await expect(page.locator("h1")).toHaveText("inkie-deck e2e harness");
});
