import type { Browser, Page } from "@playwright/test";

import { FIXTURE_SONGS, expect, test } from "../fixtures";

// The Admin area's Library problems and Songs sections (#187) against the
// real server and its fixture Library, at Phone width and with no Unlock:
// neither the list, nor Rescan, nor the Song list asks for the Admin PIN.

const PHONE_WIDTH = { width: 375, height: 740 };

async function openPhoneBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: PHONE_WIDTH,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  return context.newPage();
}

async function expectNoSideways(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("Library problems lists the rejected file and rescans without a PIN", async ({
  browser,
}) => {
  const page = await openPhoneBrowser(browser);
  await page.goto("/admin/library-problems");

  const problems = page.getByRole("list", { name: "Library problems" });
  const rejected = problems
    .getByRole("listitem")
    .filter({ hasText: FIXTURE_SONGS.rejected });
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toContainText("Rejected");
  await expect(rejected).toContainText("#VERSION");
  await expectNoSideways(page);

  // The scan's finished notice, not a timer, brings the list back.
  const refetched = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/library/problems",
  );
  const rescan = page.getByRole("button", { name: "Rescan" });
  const started = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/library/rescan" &&
      response.status() === 202,
  );
  await rescan.click();
  await started;
  await refetched;
  await expect(rescan).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("status")).not.toContainText("Scanning");
  await expect(rejected).toHaveCount(1);

  await expect(page.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  await page.context().close();
});

test("Songs lists the playable Songs and searches artist and title", async ({
  browser,
}) => {
  const page = await openPhoneBrowser(browser);
  await page.goto("/admin/songs");

  const songs = page.getByRole("list", { name: "Songs in the Library" });
  await expect(songs.getByRole("listitem")).toHaveCount(3);
  await expect(songs).toContainText("Steady Tone");
  await expect(songs).not.toContainText("Rejected");
  await expectNoSideways(page);

  await page
    .getByRole("searchbox", { name: "Search by artist or title" })
    .fill("duo");
  await expect(songs.getByRole("listitem")).toHaveCount(1);
  await expect(songs).toContainText("Two Voices");
  await expectNoSideways(page);

  await expect(page.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  await page.context().close();
});
