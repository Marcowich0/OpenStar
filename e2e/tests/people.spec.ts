import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The People tab, the Me sheet and leaving the Party (#119): one Phone
// changes its colour from the Me sheet, removes the other Phone's member
// with a press and hold, and then leaves itself. Both end outside the
// shared Party, so their colours are free again for the other tests.

/** The Stage's current Join code. */
async function stageJoinCode(stage: Page): Promise<string> {
  await stage.goto("/stage");
  const code = stage.getByTestId("party-join-code");
  await expect(code).toHaveText(/^\d{4}$/);
  return (await code.textContent()) ?? "";
}

/**
 * A Profile with a name no other test uses, and a favourite colour no other
 * test's Profile holds (the server and its Party are shared).
 */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
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

/** A Phone joins from the QR link as the Profile `name`. */
async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

test("a Phone manages itself from the Me sheet and frees colours from the People tab", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await stageJoinCode(stage);
  const keeper = await createProfile(request, "Keeper", "mint");
  const guest = await createProfile(request, "Visitor", "forest");

  const mine = await openPhone();
  await joinAs(mine, code, keeper);
  const theirs = await openPhone();
  await joinAs(theirs, code, guest);

  // The People tab lists both, with this Phone's own member tagged "me".
  await mine.getByRole("tab", { name: "People" }).click();
  await expect(
    mine.getByRole("heading", { name: "Party people" }),
  ).toBeVisible();
  await expect(mine.getByText(`Join code ${code}`)).toBeVisible();
  const myRow = mine.getByRole("listitem", { name: keeper });
  const theirRow = mine.getByRole("listitem", { name: guest });
  await expect(myRow.getByText("me", { exact: true })).toBeVisible();
  await expect(myRow.getByRole("button")).toHaveCount(0);
  await expect(theirRow.getByText("On a Phone")).toBeVisible();

  // The Me sheet: who this is, the Admin link, and a new colour.
  await mine.getByRole("button", { name: `Me: ${keeper}` }).click();
  const sheet = mine.getByRole("dialog", { name: "Me" });
  await expect(sheet.getByText("Profile · Mint")).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Admin" })).toHaveAttribute(
    "href",
    "/admin",
  );
  await sheet
    .getByRole("button", { name: "Change name, look or colour" })
    .click();
  await expect(mine.getByRole("textbox", { name: "Name" })).toHaveValue(keeper);
  await mine.getByRole("radio", { name: "Cocoa" }).check({ force: true });
  await mine.getByRole("button", { name: "Save" }).click();
  await mine.getByRole("button", { name: `Me: ${keeper}` }).click();
  await expect(
    mine.getByRole("dialog", { name: "Me" }).getByText("Profile · Cocoa"),
  ).toBeVisible();
  await mine.keyboard.press("Escape");

  // Holding the × removes the other member: every Phone sees the toast, and
  // the removed Phone is out of the Party.
  await mine.getByRole("tab", { name: "People" }).click();
  const remove = mine.getByRole("button", { name: `Remove ${guest}` });
  await remove.focus();
  await mine.keyboard.down("Enter");
  await mine.waitForTimeout(1000);
  await mine.keyboard.up("Enter");
  await expect(
    mine.getByRole("status", { name: "Party changes" }),
  ).toContainText(`${guest} left the Party. Forest is free`);
  await expect(mine.getByRole("listitem", { name: guest })).toHaveCount(0);
  await expect(
    theirs.getByRole("heading", { name: "You left the Party" }),
  ).toBeVisible();
  await theirs.getByRole("button", { name: "Join again" }).click();
  await expect(
    theirs.getByRole("heading", { name: "Join the Party" }),
  ).toBeVisible();

  // Leave party from the Me sheet.
  await mine.getByRole("button", { name: `Me: ${keeper}` }).click();
  await mine
    .getByRole("dialog", { name: "Me" })
    .getByRole("button", { name: "Leave party" })
    .click();
  await expect(
    mine.getByRole("heading", { name: "You left the Party" }),
  ).toBeVisible();
});
