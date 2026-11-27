import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// Setup › Options in real Chromium: the Stage opens it from the Setup pill
// with no Admin PIN, a change is saved at once and kept after a reload, and
// Reset puts the default back, also under a group's Advanced fold. The options are the server's, so the test
// leaves the defaults behind.

test.afterEach(async ({ request }) => {
  await request.put("/api/stage-options", { data: {} });
});

async function openOptions(stage: Page) {
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Options" }).click();
  const dialog = stage.getByRole("dialog", { name: "Options" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function saved(stage: Page) {
  return stage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/stage-options") &&
      response.request().method() === "PUT",
  );
}

async function reload(stage: Page) {
  await stage.reload();
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
}

test("the Stage changes an option, keeps it across a reload and resets it", async ({
  stage,
}) => {
  await newParty(stage);
  const open = () => openOptions(stage);

  let options = await open();
  // Players, Sing screen, Sound; Look has no option yet.
  await expect(options.getByRole("heading", { level: 3 })).toHaveText([
    "Players",
    "Sing screen",
    "Sound",
  ]);
  const effects = options.getByRole("switch", { name: "Effects" });
  await expect(effects).toHaveAttribute("aria-checked", "true");
  const put = saved(stage);
  await effects.click();
  expect((await put).ok()).toBe(true);
  await expect(effects).toHaveAttribute("aria-checked", "false");

  await reload(stage);
  options = await open();
  const kept = options.getByRole("switch", { name: "Effects" });
  await expect(kept).toHaveAttribute("aria-checked", "false");

  await options
    .getByRole("button", { name: "Reset Effects to its default" })
    .click();
  await expect(kept).toHaveAttribute("aria-checked", "true");
});

test("an option under Advanced marks its fold, across a reload, until it is reset", async ({
  stage,
}) => {
  await newParty(stage);
  let options = await openOptions(stage);
  const sound = options.getByTestId("options-sound");
  let fold = sound.getByRole("button", { name: /^Advanced/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold.getByTestId("options-advanced-changed")).toHaveCount(0);

  await fold.click();
  const put = saved(stage);
  await sound
    .getByRole("button", { name: "Countdown after a pause down" })
    .click();
  expect((await put).ok()).toBe(true);
  await expect(
    sound.getByLabel("Countdown after a pause", { exact: true }),
  ).toHaveText("2 seconds");
  await expect(fold.getByTestId("options-advanced-changed")).toBeVisible();

  await reload(stage);
  options = await openOptions(stage);
  fold = options
    .getByTestId("options-sound")
    .getByRole("button", { name: /^Advanced/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold.getByTestId("options-advanced-changed")).toBeVisible();

  await fold.click();
  await options
    .getByRole("button", {
      name: "Reset Countdown after a pause to its default",
    })
    .click();
  await expect(fold.getByTestId("options-advanced-changed")).toHaveCount(0);
});
