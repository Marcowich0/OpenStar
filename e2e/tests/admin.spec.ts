import type { Browser, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The Admin area at Phone width (#185): every section without horizontal
// scrolling, and the guarded-action flow against the real server's guard.
//
// The test-only guarded action (`/admin?test=guarded`) sends
// `POST /api/unlock/heartbeat`, which the real binary guards, so the check
// needs no test-only route on the server.

/** The Admin PIN `scripts/e2e.sh` starts the server with. */
const ADMIN_PIN = "1234";

/** The narrowest Phone the Admin area is made for. */
const PHONE_WIDTH = { width: 375, height: 740 };

const SECTIONS = ["Downloads", "Songs", "Library problems", "Profiles"];

/** A fresh browser (no Unlock) at Phone width. */
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

test("every Admin area section opens at Phone width without a PIN", async ({
  browser,
}) => {
  const page = await openPhoneBrowser(browser);
  await page.goto("/admin");
  const nav = page.getByRole("navigation", { name: "Admin sections" });
  await expect(nav).toBeVisible();
  await expectNoSideways(page);

  for (const name of SECTIONS) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    await expectNoSideways(page);
  }
  await expect(page.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Lock" })).toHaveCount(0);
  await page.context().close();
});

test("a guarded action asks for the PIN once, completes, and Lock ends the Unlock", async ({
  browser,
}) => {
  const page = await openPhoneBrowser(browser);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/unlock/heartbeat")) sent.push("action");
  });
  await page.goto("/admin?test=guarded");

  const action = page.getByRole("button", { name: "Test guarded action" });
  await action.click();
  const pad = page.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toBeVisible();
  for (const digit of ADMIN_PIN)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();

  await expect(pad).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(
    "The guarded action is done",
  );
  const lock = page.getByRole("button", { name: "Lock" });
  await expect(lock).toBeVisible();
  // Refused once, sent once more after the PIN: never started twice.
  expect(sent).toEqual(["action", "action"]);

  // A second guarded action goes straight through.
  await action.click();
  await expect.poll(() => sent.length).toBe(3);
  await expect(pad).toHaveCount(0);

  // Lock ends the Unlock; the next guarded action asks again.
  await lock.click();
  await expect(lock).toHaveCount(0);
  await action.click();
  await expect(pad).toBeVisible();
  await pad.getByRole("button", { name: "Cancel" }).click();
  await expect(pad).toHaveCount(0);
  await page.context().close();
});
