import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// The Phone's New Profile and Guest form at 390×844 (#256): its Join
// button stays on screen at every scroll position, and Back is the height
// of the header's other buttons (the Me button, once joined).

const PHONE = { width: 390, height: 844 };

/** The Join button is on screen and nothing covers its middle. */
async function expectJoinInReach(phone: Page, name: string) {
  const join = phone.getByRole("button", { name: `Join as ${name}` });
  await expect(join).toBeInViewport({ ratio: 1 });
  const hit = await join.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return top !== null && button.contains(top);
  });
  expect(hit).toBe(true);
}

for (const [button, heading] of [
  ["I'm a Guest", "New Guest"],
  ["New Profile", "New Profile"],
] as const) {
  test(`${button}: Join stays in reach at 390×844 and Back is header-sized`, async ({
    stage,
    openPhone,
  }) => {
    const code = await newParty(stage);
    const name = `Form ${String(Date.now() % 100000)}`;
    const phone = await openPhone();
    await phone.setViewportSize(PHONE);
    await phone.goto(`/?join=${code}`);
    await phone.getByRole("button", { name: button }).click();
    await expect(phone.getByRole("heading", { name: heading })).toBeVisible();

    const back = await phone
      .getByRole("button", { name: "Back" })
      .boundingBox();
    await phone.getByRole("textbox", { name: "Name" }).fill(name);
    await expect(phone.getByTestId("avatar-preview")).toContainText(name);

    // The form is taller than the screen; Join stays in reach all the way.
    const scrollable = await phone.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(scrollable).toBeGreaterThan(0);
    for (const share of [0, 0.5, 1]) {
      await phone.evaluate((y) => {
        window.scrollTo(0, y);
      }, scrollable * share);
      await expectJoinInReach(phone, name);
    }

    await phone.getByRole("button", { name: `Join as ${name}` }).click();
    const me = phone.getByRole("button", { name: `Me: ${name}` });
    await expect(me).toBeVisible();
    const meBox = await me.boundingBox();
    expect(back?.height).toBeCloseTo(meBox?.height ?? 0, 0);
  });
}
