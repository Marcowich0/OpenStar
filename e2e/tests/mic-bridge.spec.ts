import { expect, test } from "../fixtures";

// A Mic bridge on the Stage's Mics screen: `scripts/e2e.sh` starts the real
// `openstar-mic-bridge --wav` on the fake mic's 4-channel WAV (the tone on
// channel 0, silence on the rest) against the server. It waits for
// approval; once the Stage approves it, its group's rows show live meters
// fed by the levels it sends while the Mics screen is open. No channel is
// switched on, so nothing reaches the Line-up of later tests.

/** The `aria-valuenow` of each meter. */
const meterValues = (meters: import("@playwright/test").Locator) =>
  meters.evaluateAll((all) =>
    all.map((m) => Number(m.getAttribute("aria-valuenow"))),
  );

test("a Mic bridge in --wav mode shows moving meters on the Mics screen once approved", async ({
  stage,
}) => {
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "songBrowser",
  );
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  const mics = stage.getByRole("dialog", { name: "Mics" });

  // The bridge waits for approval (a retry finds it approved already).
  const waiting = mics.getByRole("group", { name: "New bridges" });
  const bridge = mics.getByTestId("mics-bridge");
  await expect(waiting.or(bridge).first()).toBeVisible({ timeout: 15_000 });
  if (await waiting.isVisible()) {
    await waiting
      .getByRole("button", { name: /^Approve mic bridge .*, code \d{4}$/ })
      .click();
  }
  await expect(bridge).toBeVisible();
  await expect(bridge.getByText("Open", { exact: true })).toBeVisible();

  // One row per WAV channel, each with a meter.
  const meters = bridge.getByRole("meter");
  await expect(meters).toHaveCount(4);
  await expect(meters.first()).toHaveAccessibleName(
    "multichannel.wav · Input 1 level",
  );

  // Channel 0 hears the tone, so its meter moves off the floor; the silent
  // channels stay on it.
  await expect
    .poll(async () => (await meterValues(meters))[0], {
      timeout: 15_000,
      intervals: [50],
    })
    .toBeGreaterThan(-40);
  const values = await meterValues(meters);
  expect(values.slice(1)).toEqual([-60, -60, -60]);
});
