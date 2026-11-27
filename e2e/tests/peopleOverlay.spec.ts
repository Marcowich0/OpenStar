import type { APIRequestContext, Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

// The Stage's People overlay, "Tonight's Party" (#181): the twelve Party
// colours with who holds each, the join card that always shows the code,
// and removing a Party member with a hold of Enter. It starts a New party
// first (from the same overlay), so its Profiles' colours are free.

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

async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

test("the Stage's People overlay shows the twelve colours and removes a member with a hold", async ({
  stage,
  openPhone,
  request,
}, testInfo) => {
  const code = await newParty(stage);
  const ada = await createProfile(request, "Ada", "sky");
  const ben = await createProfile(request, "Ben", "berry");
  await joinAs(await openPhone(), code, ada);
  await joinAs(await openPhone(), code, ben);

  await stage.keyboard.press("p");
  const people = stage.getByRole("dialog", { name: "Tonight's Party" });
  await expect(people.getByText("2 of 12 colours taken")).toBeVisible();
  const spots = people
    .getByRole("list", { name: "Party colours" })
    .getByRole("listitem");
  await expect(spots).toHaveCount(12);
  const adaSpot = people.getByRole("listitem", { name: ada });
  await expect(adaSpot.getByText("Profile")).toBeVisible();
  await expect(adaSpot.getByText("Phone")).toBeVisible();
  await expect(
    people.getByRole("listitem", { name: "Cherry is free" }),
  ).toBeVisible();
  await expect(people.getByTestId("party-join-code")).toHaveText(code);
  // The "joined" toasts fade after about 4 s; the shot is of the overlay.
  await expect(stage.getByText(/joined the Party/)).toHaveCount(0, {
    timeout: 10_000,
  });
  await stage.screenshot({ path: testInfo.outputPath("people-overlay.png") });

  await holdToConfirm(
    adaSpot.getByRole("button", { name: `Hold to remove ${ada}` }),
  );
  await expect(
    people.getByRole("listitem", { name: "Sky is free" }),
  ).toBeVisible();
  await expect(people.getByText("1 of 12 colours taken")).toBeVisible();
});
