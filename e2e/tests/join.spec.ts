import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The join flow as a Profile (#115): a Phone joins by the Join code on the
// number pad or from the QR link, picks its Profile, lands on the Remote, and
// is back in after a reload with no code and no tap.

/** The Stage's current Join code. */
async function stageJoinCode(stage: Page): Promise<string> {
  await stage.goto("/stage");
  const code = stage.getByTestId("party-join-code");
  await expect(code).toHaveText(/^\d{4}$/);
  return (await code.textContent()) ?? "";
}

/** A Profile with a name no other test uses (the server is shared). */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour: "teal",
    },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/** A well-formed Join code that is not `code`. */
function otherCode(code: string): string {
  return String((Number(code) + 1) % 10000).padStart(4, "0");
}

async function typeOnPad(phone: Page, code: string) {
  for (const digit of code)
    await phone.getByRole("button", { name: digit, exact: true }).click();
}

const remoteTabs = ["Songs", "Queue", "Stage", "People"];

async function expectRemote(phone: Page, name: string) {
  await expect(phone.getByRole("tab")).toHaveText(remoteTabs);
  await expect(phone.getByRole("img", { name })).toBeVisible();
}

test("a Phone joins by the Join code on the pad as a Profile and rejoins silently", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await stageJoinCode(stage);
  const name = await createProfile(request, "Pad");

  const phone = await openPhone();
  await phone.goto("/");
  await expect(
    phone.getByRole("heading", { name: "Join the Party" }),
  ).toBeVisible();
  await expect(
    phone.getByText("Type the 4 numbers shown on the Stage, under the QR code"),
  ).toBeVisible();

  await typeOnPad(phone, otherCode(code));
  await expect(phone.getByText("That code is not on the Stage")).toBeVisible();

  await typeOnPad(phone, code);
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
  await phone.getByRole("button", { name, exact: true }).click();
  await expectRemote(phone, name);
  expect(
    await phone.evaluate(() => localStorage.getItem("openstar.profileId")),
  ).toMatch(/^\d+$/);

  await phone.reload();
  await expectRemote(phone, name);
  await expect(
    phone.getByRole("heading", { name: "Join the Party" }),
  ).toHaveCount(0);
});

test("the QR link skips the pad, and a remembered Profile joins with one tap", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await stageJoinCode(stage);
  const name = await createProfile(request, "QR");

  const phone = await openPhone();
  await phone.goto(`/?join=${otherCode(code)}`);
  await expect(phone.getByText("That code is not on the Stage")).toBeVisible();

  await phone.goto(`/?join=${code}`);
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
  await phone.getByRole("button", { name, exact: true }).click();
  await expectRemote(phone, name);

  // The same browser as a new Phone (its Phone id gone) still remembers the
  // Profile it joined as.
  await phone.evaluate(() => {
    localStorage.removeItem("openstar.phoneId");
  });
  await phone.goto(`/?join=${code}`);
  const imName = phone.getByRole("button", { name: `I'm ${name}` });
  await expect(imName).toBeVisible();
  // The button breathes forever, so it is never "stable" for a normal click.
  await imName.click({ force: true });
  await expectRemote(phone, name);
});
