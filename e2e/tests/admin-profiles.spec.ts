import type { APIRequestContext, Page } from "@playwright/test";

import { ADMIN_PIN, expect, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

// The Admin area's Profiles section (#199) against the real server: a Profile
// that is a Party member on a Phone is deleted with an Unlock plus a press
// and hold. The Stage and the Phone see the toast, and the Phone is put out
// of the Party. The PIN is entered once, right; no wrong guesses.

/** A Profile with a name no other test uses (the server is shared). */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: { name, avatar: { kind: "builtIn", key: "rocket" }, favouriteColour },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/** Holds the button `name` down with the Enter key for longer than a hold needs. */
async function hold(page: Page, name: string) {
  await holdToConfirm(page.getByRole("button", { name }));
}

test("deleting a Party member's Profile needs the PIN and a hold, and the Party lets it go", async ({
  stage,
  openPhone,
  request,
  browser,
}) => {
  const code = await newParty(stage);
  const name = await createProfile(request, "Gone", "sky");

  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  // The Remote's People tab offers no delete.
  await phone.getByRole("tab", { name: "People" }).click();
  await expect(phone.getByRole("listitem", { name })).toBeVisible();
  await expect(
    phone.getByRole("button", { name: `Delete ${name}` }),
  ).toHaveCount(0);

  const context = await browser.newContext({
    viewport: { width: 375, height: 740 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const admin = await context.newPage();
  await admin.goto("/admin/profiles");
  const row = admin.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Never sung");

  // A plain tap does nothing but say how.
  await admin.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(row.getByText("Hold for a moment")).toBeVisible();
  const pad = admin.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toHaveCount(0);

  // A hold without an Unlock asks for the PIN first, then deletes.
  await hold(admin, `Delete ${name}`);
  await expect(pad).toBeVisible();
  for (const digit of ADMIN_PIN)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();
  await expect(pad).toHaveCount(0);
  await expect(row).toHaveCount(0);

  await expect(
    stage.getByRole("status", { name: "Party changes" }),
  ).toContainText(`${name}'s Profile was deleted. Sky is free`);
  await expect(
    phone.getByRole("heading", { name: "You left the Party" }),
  ).toBeVisible();
  await context.close();
});
