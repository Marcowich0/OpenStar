import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// "Calibrate this mic now" (#210) with the Stage browser's own Local mic:
// switching it on in the Mics screen offers the run, accepting starts it with
// that Local mic alone (its device is open, so it is ready and the tones play
// at once), its result row names it, and a later Calibrate mics run lists it
// on the checklist unticked. Chromium's fake microphone beeps rather than
// hearing the tones, so the result may be either row; the server tests cover
// what a success stores.

/** Waits for the page's running animations (an overlay fading in) to end. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // A looping animation never finishes.
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
}

test("Calibrate this mic now runs the tones with only that Local mic, and a later checklist lists it unticked", async ({
  micStage: stage,
}, testInfo) => {
  test.setTimeout(60_000);
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "songBrowser",
  );
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  const mics = stage.getByRole("dialog", { name: "Mics" });
  const group = mics.getByRole("group", { name: "This browser" });
  const firstRow = group.locator("li[data-local-mic]").first();
  await expect(firstRow).toBeVisible();
  // Pinned to its Local mic: rows keep arriving as inputs are listed.
  const localMicId = (await firstRow.getAttribute("data-local-mic")) ?? "";
  const row = group.locator(`li[data-local-mic="${localMicId}"]`);
  const toggle = row.getByRole("switch");
  const name = ((await toggle.getAttribute("aria-label")) ?? "").replace(
    / switched on$/,
    "",
  );
  expect(name).not.toBe("");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const offer = mics.getByTestId("mics-calibrate-offer");
  await expect(offer).toBeVisible();
  await settled(stage);
  await stage.screenshot({
    path: testInfo.outputPath("calibrate-this-mic-now.png"),
  });
  await offer.getByRole("button", { name: "Calibrate this mic now" }).click();

  // The run, past the checklist, with only that Local mic: its device is
  // open, so the tones start, then its one result row.
  const calibrate = stage.getByRole("dialog", { name: "Calibrate mics" });
  const results = calibrate.getByTestId("calibration-results");
  await expect(results).toBeVisible({ timeout: 20_000 });
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results.getByRole("listitem")).toContainText(name);
  await calibrate.getByRole("button", { name: "Done" }).click();
  await expect(calibrate).toBeHidden();

  // A later Calibrate mics run lists it, unticked.
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage
    .getByRole("menuitem", { name: "Calibrate mics", exact: true })
    .click();
  const box = calibrate.getByRole("checkbox", { name });
  await expect(box).toHaveAttribute("aria-checked", "false");
  await settled(stage);
  await stage.screenshot({
    path: testInfo.outputPath("calibrate-checklist-local-mic.png"),
  });
  await calibrate.getByRole("button", { name: "Cancel" }).click();
  await expect(calibrate).toBeHidden();

  // Switched off again, so the tests after this one start with none on.
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});
