import { expect, newParty, test } from "../fixtures";

// Setup › Options in real Chromium: the Stage opens it from the Setup pill
// with no Admin PIN, a change is saved at once and kept after a reload, and
// Reset puts the default back. The options are the server's, so the test
// leaves the defaults behind.

test.afterEach(async ({ request }) => {
  await request.put("/api/stage-options", { data: {} });
});

test("the Stage changes an option, keeps it across a reload and resets it", async ({
  stage,
}) => {
  await newParty(stage);
  const open = async () => {
    await stage.getByRole("button", { name: "Setup" }).click();
    await stage.getByRole("menuitem", { name: "Options" }).click();
    const dialog = stage.getByRole("dialog", { name: "Options" });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  let options = await open();
  const effects = options.getByRole("switch", { name: "Effects" });
  await expect(effects).toHaveAttribute("aria-checked", "true");
  const saved = stage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/stage-options") &&
      response.request().method() === "PUT",
  );
  await effects.click();
  expect((await saved).ok()).toBe(true);
  await expect(effects).toHaveAttribute("aria-checked", "false");

  await stage.reload();
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  options = await open();
  const kept = options.getByRole("switch", { name: "Effects" });
  await expect(kept).toHaveAttribute("aria-checked", "false");

  await options
    .getByRole("button", { name: "Reset Effects to its default" })
    .click();
  await expect(kept).toHaveAttribute("aria-checked", "true");
});
