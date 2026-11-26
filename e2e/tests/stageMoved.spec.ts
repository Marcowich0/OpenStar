import type { Locator, Page } from "@playwright/test";

import {
  ADMIN_PIN,
  STAGE_VIEWPORT,
  expect,
  newParty,
  test,
  trustStageBrowser,
} from "../fixtures";

// Stage moved here (#201): two Stage browsers take the Stage from each other.
// The `stage` page starts the Party; a second browser opens `/stage` and the
// first shows Stage moved here. The first takes it back with the hold alone
// (it is a remembered Stage browser); then the second, which has lost its
// Stage cookie while the page stayed open, needs the Admin PIN after
// the hold. A Phone stays in the Party throughout.

async function holdTakeBack(page: Page) {
  const button = page.getByRole("button", {
    name: "Make this the Stage again",
  });
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
}

function moved(page: Page): Locator {
  return page.getByTestId("stage-moved");
}

async function expectStage(page: Page, code: string) {
  await expect(page.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "songBrowser",
  );
  await expect(page.getByTestId("party-join-code")).toHaveText(code);
}

test("the old Stage says the Stage moved and takes it back with a hold", async ({
  stage,
  browser,
  baseURL,
  openPhone,
  request,
}, testInfo) => {
  const code = await newParty(stage);
  const name = `Mover ${String(Date.now() % 100000)}`;
  const profile = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour: "mint",
    },
  });
  expect(profile.ok()).toBe(true);
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();

  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  await trustStageBrowser(context);
  const other = await context.newPage();
  await other.goto("/stage");
  await expectStage(other, code);

  // The old Stage says so, and knows the Admin PIN already.
  await expect(moved(stage)).toBeVisible();
  await expect(
    stage.getByRole("heading", { name: "The Stage moved to another screen" }),
  ).toBeVisible();
  await expect(
    stage.getByText(
      "Hold for a moment. This browser already knows the admin PIN.",
    ),
  ).toBeVisible();
  // What each browser shows, kept in the test's output folder.
  // The join toast has faded by then.
  await stage.waitForTimeout(4500);
  await stage.screenshot({ path: testInfo.outputPath("stage-moved-old.png") });
  await other.screenshot({ path: testInfo.outputPath("stage-moved-new.png") });

  // The hold alone takes it back; the Party is the same one.
  await holdTakeBack(stage);
  await expectStage(stage, code);
  await expect(stage.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
  await expect(moved(other)).toBeVisible();
  await stage.keyboard.press("p");
  await expect(
    stage
      .getByRole("dialog", { name: "Tonight's Party" })
      .getByText("hold to remove"),
  ).toHaveCount(1);
  await stage.keyboard.press("Escape");
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();

  // A browser that is no longer remembered (its Stage cookie is gone while
  // the page stays open) is asked for the Admin PIN after the hold.
  await context.clearCookies();
  await holdTakeBack(other);
  const pad = other.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toBeVisible();
  for (const digit of ADMIN_PIN)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();
  await expectStage(other, code);
  await expect(moved(stage)).toBeVisible();

  await context.close();
});
