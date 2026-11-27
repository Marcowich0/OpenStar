import { expect, newParty, test } from "../fixtures";

// The Profile page on the Stage (#273): Enter on a Profile's card in the
// People overlay opens its page over the overlay, Esc goes back to the
// overlay with the focus where it was. A Guest's card opens nothing.

test("opens a Profile page from the Stage's People overlay with the keyboard, and Esc closes it", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const name = `Ada ${String(Date.now() % 100000)}`;
  const created = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour: "sky",
    },
  });
  expect(created.ok()).toBe(true);
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();

  await stage.keyboard.press("p");
  const people = stage.getByRole("dialog", { name: "People" });
  await expect(people).toBeVisible();
  const open = people.getByRole("button", {
    name: `Open ${name}'s Profile page`,
  });
  await expect(open).toBeVisible();
  // Tab walks the overlay in document order, from its close control.
  for (let step = 0; step < 4; step += 1) {
    if (await open.evaluate((element) => element === document.activeElement))
      break;
    await stage.keyboard.press("Tab");
  }
  await expect(open).toBeFocused();

  await stage.keyboard.press("Enter");
  const page = stage.getByRole("dialog", { name: `${name}'s Profile page` });
  await expect(page).toBeVisible();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("No Songs sung yet")).toBeVisible();

  await stage.keyboard.press("Escape");
  await expect(page).toHaveCount(0);
  await expect(people).toBeVisible();
  await expect(open).toBeFocused();
});
