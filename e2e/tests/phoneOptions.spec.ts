import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";
import { createProfile } from "../flows";

// The Stage options on a Phone (#271): Options on the Stage tab opens the
// Stage's list as a full-height sheet that fits a 390×844 screen, a change
// there shows at once in the Stage's own open Options, the Stage toasts it
// with the Phone user's avatar, and Back closes the sheet. The options are the server's, so the
// test leaves the defaults behind.

const SMALL_PHONE = { width: 390, height: 844 };

test.afterEach(async ({ request }) => {
  await request.put("/api/stage-options", { data: {} });
});

async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

test("a Phone changes an option and the Stage shows it and toasts who did", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const name = await createProfile(request, "Sam", "teal");
  const phone = await openPhone();
  await phone.setViewportSize(SMALL_PHONE);
  await joinAs(phone, code, name);

  // The Stage's own Options stay open while the Phone changes one.
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Options" }).click();
  const onStage = stage.getByRole("dialog", { name: "Options" });
  const stageRatings = onStage.getByRole("switch", { name: "Line ratings" });
  await expect(stageRatings).toHaveAttribute("aria-checked", "true");

  await phone.getByRole("tab", { name: "Stage" }).click();
  await phone.getByRole("button", { name: "Options" }).click();
  const sheet = phone.getByRole("dialog", { name: "Options" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { level: 3 })).toHaveText([
    "Players",
    "Sing screen",
    "Sound",
  ]);

  // It covers the screen, and nothing in it is wider than the screen.
  const box = await sheet.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(SMALL_PHONE.height - 60);
  expect(
    await phone.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(SMALL_PHONE.width);
  for (const row of await sheet.locator("[data-option]").all()) {
    const rowBox = await row.boundingBox();
    expect(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0),
      (await row.getAttribute("data-option")) ?? "",
    ).toBeLessThanOrEqual(SMALL_PHONE.width);
  }

  const phoneRatings = sheet.getByRole("switch", { name: "Line ratings" });
  await phoneRatings.click();
  await expect(phoneRatings).toHaveAttribute("aria-checked", "false");
  await expect(stageRatings).toHaveAttribute("aria-checked", "false");

  // The Stage's modal hides the toasts from the accessibility tree only.
  const toasts = stage.getByRole("status", {
    name: "Party changes",
    includeHidden: true,
  });
  const toast = toasts
    .getByRole("listitem", { includeHidden: true })
    .filter({ hasText: `${name} changed Line ratings` });
  await expect(toast).toBeAttached();
  await expect(
    toast.getByRole("img", { name, includeHidden: true }),
  ).toBeAttached();

  // Reset on the Phone puts the default back on the Stage too.
  await sheet
    .getByRole("button", { name: "Reset Line ratings to its default" })
    .click();
  await expect(stageRatings).toHaveAttribute("aria-checked", "true");

  await sheet.getByRole("button", { name: "Back" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(phone.getByRole("button", { name: "Options" })).toBeVisible();
});
