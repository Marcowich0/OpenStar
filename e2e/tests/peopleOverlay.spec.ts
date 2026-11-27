import type { APIRequestContext, Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

// The Stage's People overlay (#181, reordered by #249): the Party members
// first as cards, then the free colours as named swatches, the join card
// that always shows the code, and removing a Party member with a hold of
// Enter. It starts a New party first (from the same overlay), so its
// Profiles' colours are free.

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

test("the Stage's People overlay lists the members, then the free colours, and removes a member with a hold", async ({
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
  const cards = people
    .getByRole("list", { name: "Party members" })
    .getByRole("listitem");
  await expect(cards).toHaveCount(2);
  const free = people.getByRole("list", { name: "Free colours" });
  await expect(free.getByRole("listitem")).toHaveCount(10);
  const adaCard = cards.filter({ hasText: ada });
  await expect(adaCard.getByText("Profile")).toBeVisible();
  await expect(adaCard.getByText("Phone")).toBeVisible();
  await expect(free.getByText("Cherry", { exact: true })).toBeVisible();
  await expect(
    people.getByRole("button", { name: "New party" }),
  ).toHaveAccessibleDescription(
    "Clears the Queue and the people, and makes a new Join code",
  );
  await expect(people.getByTestId("party-join-code")).toHaveText(code);
  // The "joined" toasts fade after about 4 s; the shot is of the overlay.
  await expect(stage.getByText(/joined the Party/)).toHaveCount(0, {
    timeout: 10_000,
  });
  await stage.screenshot({ path: testInfo.outputPath("people-overlay.png") });

  await holdToConfirm(
    adaCard.getByRole("button", { name: `Hold to remove ${ada}` }),
  );
  await expect(cards).toHaveCount(1);
  await expect(free.getByText("Sky", { exact: true })).toBeVisible();
  await expect(people.getByText("1 of 12 colours taken")).toBeVisible();
});
