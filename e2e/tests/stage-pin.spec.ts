import { ADMIN_PIN, STAGE_VIEWPORT, becomeStageWithPin, expect, test } from "../fixtures";

// Becoming the Stage needs the Admin PIN once per browser (#186). This spec
// uses a browser context of its own that is not remembered yet; every other
// spec gets a remembered one from the `stage` fixture. It makes one wrong
// guess only: the wrong-guess wait is shared by the whole run.

test("a new browser gives the Admin PIN on /stage once, then becomes the Stage with no pad", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const page = await context.newPage();

  await page.goto("/stage");
  const pad = page.getByRole("dialog", { name: "Admin PIN" });
  await expect(pad).toBeVisible();
  // Before anything else: no Stage frame behind the pad.
  await expect(page.locator("[data-stage-frame]")).toHaveCount(0);

  // A wrong PIN is refused and the pad stays.
  const wrong = ADMIN_PIN === "0000" ? "1111" : "0000";
  for (const digit of wrong)
    await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "OK" }).click();
  await expect(pad.getByText("That is not the Admin PIN")).toBeVisible();
  await expect(page.locator("[data-stage-frame]")).toHaveCount(0);

  // The reusable step: the right PIN, and the Stage frame comes.
  await becomeStageWithPin(page);

  // Remembered: a reload, and a new tab in the same browser, show no pad.
  await page.reload();
  await expect(page.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  await expect(pad).toHaveCount(0);
  const again = await context.newPage();
  await again.goto("/stage");
  await expect(again.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  await expect(again.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);

  await context.close();
});
