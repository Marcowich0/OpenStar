import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The OpenStar volume (#157): `+` and `-` on the Stage step it through the
// server, which keeps it per (Stage browser, Stage output), so a reloaded
// Stage finds the value it left. It joins no Party, so it needs no New party.

/** Presses `key` until the volume pill shows (the Stage reports its output
 * first), and returns the volume it shows. */
async function step(stage: Page, key: "+" | "-"): Promise<number> {
  const pill = stage.getByTestId("volume-pill");
  await expect(pill).toHaveCount(0);
  await expect(async () => {
    await stage.keyboard.press(key);
    await expect(pill).toBeVisible({ timeout: 500 });
  }).toPass();
  const text = (await pill.textContent()) ?? "";
  expect(text).toMatch(/^Volume \d+$/);
  // It goes again after about 1.5 s; it is not a toast.
  await expect(pill).toHaveCount(0, { timeout: 3000 });
  return Number(text.slice("Volume ".length));
}

test("the Stage steps the volume and finds it again after a reload", async ({
  stage,
}) => {
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );

  const up = await step(stage, "+");
  expect(up % 5).toBe(0);

  await stage.reload();
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    /.+/,
  );
  const down = await step(stage, "-");
  // Kept on the server: one step down from where the last Stage left it.
  expect(down).toBe(Math.max(up - 5, 0));
});
