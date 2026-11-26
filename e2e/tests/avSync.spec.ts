import type { APIRequestContext, Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// Check A/V sync (#163) in real Chromium: the Stage opens it from the Setup
// pill with no Admin PIN, the ball bounces on the canvas while the clicks
// play, ←/→ on the Stage and −/+ on a Phone's Stage tab step the Stage's
// own A/V offset (saved at once, so a reopened check shows it), and Done on
// the Phone ends it everywhere.

async function createProfile(
  request: APIRequestContext,
  favouriteColour: string,
): Promise<string> {
  const name = `Syncer ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour,
    },
  });
  expect(response.ok()).toBe(true);
  return name;
}

async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

test("the Stage and a Phone set the A/V offset by eye and ear", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const name = await createProfile(request, "navy");
  const phone = await openPhone();
  await joinAs(phone, code, name);
  await phone.getByRole("tab", { name: "Stage" }).click();

  // From the Stage's Setup pill.
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Check A/V sync" }).click();
  const check = stage.getByRole("dialog", { name: "Check A/V sync" });
  await expect(check).toBeVisible();
  const value = check.getByTestId("av-sync-value");
  // Start from 0, whatever an earlier run left.
  await check.getByRole("button", { name: "Reset to 0" }).click();
  await expect(value).toHaveText("0 ms");

  // The ball moves: two frames of the canvas differ.
  const pattern = check.getByRole("img", { name: /ball bouncing/ });
  const first = await pattern.screenshot();
  await stage.waitForTimeout(300);
  expect((await pattern.screenshot()).equals(first)).toBe(false);

  await stage.keyboard.press("ArrowRight");
  await stage.keyboard.press("ArrowRight");
  await expect(value).toHaveText("+20 ms");
  await stage.keyboard.press("ArrowLeft");
  await expect(value).toHaveText("+10 ms");

  // The Phone shows its big −/+ while the check runs.
  const card = phone.getByTestId("av-sync-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "A/V offset up" }).click();
  await card.getByRole("button", { name: "A/V offset up" }).click();
  await expect(value).toHaveText("+30 ms");
  await card.getByRole("button", { name: "A/V offset down" }).click();
  await expect(value).toHaveText("+20 ms");

  // Done on the Phone ends it on the Stage too.
  await card.getByRole("button", { name: "Done" }).click();
  await expect(check).toHaveCount(0);
  await expect(card).toHaveCount(0);

  // Started from the Phone, it opens on the Stage with the saved value.
  await phone.getByRole("button", { name: "Check A/V sync" }).click();
  await expect(check).toBeVisible();
  await expect(value).toHaveText("+20 ms");
  await check.getByRole("button", { name: "Reset to 0" }).click();
  await expect(value).toHaveText("0 ms");
  await stage.keyboard.press("Escape");
  await expect(check).toHaveCount(0);
  await expect(card).toHaveCount(0);
});
