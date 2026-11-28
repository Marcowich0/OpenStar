import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";
import { createProfile } from "../flows";

// The OpenStar volume (#157): `+` and `-` on the Stage step it through the
// server, which keeps it per (Stage browser, Stage output), so a reloaded
// Stage finds the value it left. It joins no Party, so it needs no New party.

/** Presses `key` until the volume pill shows (the Stage reports its output
 * first), and returns the volume it shows. */
async function step(stage: Page, key: "+" | "-"): Promise<number> {
  const pill = stage.getByTestId("volume-pill");
  await expect(pill).toHaveCount(0);
  await expect(async () => {
    await stage.keyboard.press(key);
    await expect(pill).toBeVisible({ timeout: 500 });
  }).toPass();
  const text = (await pill.textContent()) ?? "";
  expect(text).toMatch(/^Volume \d+$/);
  // It goes again after about 1.5 s; it is not a toast.
  await expect(pill).toHaveCount(0, { timeout: 3000 });
  return Number(text.slice("Volume ".length));
}

test("the Stage steps the volume and finds it again after a reload", async ({
  stage,
}) => {
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );

  const up = await step(stage, "+");
  expect(up % 5).toBe(0);

  await stage.reload();
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  const down = await step(stage, "-");
  // Kept on the server: one step down from where the last Stage left it.
  expect(down).toBe(Math.max(up - 5, 0));
});

async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

// Options › Sound (#270): its OpenStar volume row is the same value as the
// Phone's Volume control, on the Stage and in a Phone's Options sheet, each
// way, and Reset sets 80.
test("the OpenStar volume in Options and on the Phone's Stage tab stay in sync both ways", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const name = await createProfile(request, "Vol", "sky");
  const phone = await openPhone();
  await joinAs(phone, code, name);
  await phone.getByRole("tab", { name: "Stage" }).click();
  const control = phone.getByRole("group", { name: "Volume" });

  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Options" }).click();
  const onStage = stage
    .getByRole("dialog", { name: "Options" })
    .locator('[data-option="openStarVolume"]');
  const value = onStage.locator('p[aria-label="OpenStar volume"]');
  // The Stage tells its output's volume once it has reported it.
  await expect(value).toHaveText(/^\d+$/);
  const reset = onStage.getByRole("button", {
    name: "Reset OpenStar volume to its default",
  });
  if ((await value.textContent()) !== "80") await reset.click();
  await expect(value).toHaveText("80");
  await expect(control).toContainText("80");
  await expect(reset).toHaveAttribute("aria-disabled", "true");

  // The Phone's control moves the Stage's row…
  await control.getByRole("button", { name: "Volume up" }).click();
  await expect(value).toHaveText("85");
  await expect(control).toContainText("85");

  // …and the Stage's row moves the Phone's control.
  const down = onStage.getByRole("button", { name: "OpenStar volume down" });
  await down.click();
  await expect(value).toHaveText("80");
  await down.click();
  await expect(value).toHaveText("75");
  await expect(control).toContainText("75");

  // The Phone's Options sheet has the same row, bound to the same value.
  await phone.getByRole("button", { name: "Options" }).click();
  const sheet = phone
    .getByRole("dialog", { name: "Options" })
    .locator('[data-option="openStarVolume"]');
  await expect(sheet).toContainText("75");
  await sheet
    .getByRole("button", { name: "Reset OpenStar volume to its default" })
    .click();
  await expect(value).toHaveText("80");
  await expect(sheet).toContainText("80");
});
