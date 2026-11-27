import type { Locator, Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// The Stage's stacking order (#245, `web/src/theme/layers.ts`): the Setup menu
// lies over the join card, and an open overlay's veil covers the whole scene,
// the join card's Hide pill and every Stage menu pill included, so none of
// them can be hit.

/** The centre of `locator`, in page px. */
async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not laid out");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** What `elementFromPoint` hits at `point`, as the selector it matches. */
async function hitAt(
  stage: Page,
  point: { x: number; y: number },
  selector: string,
): Promise<boolean> {
  return stage.evaluate(
    ({ x, y, selector }) =>
      document.elementFromPoint(x, y)?.closest(selector) != null,
    { ...point, selector },
  );
}

/** Waits until `locator`'s own animations (its pop-in) have finished. */
async function settled(locator: Locator): Promise<void> {
  await locator.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

const HIDE = "aside[data-layout] button";
const PILLS =
  "[data-testid=pill-row] > button, [data-testid=pill-row] > span > button";

/** The centres of the Hide pill and of every Stage menu pill. */
async function sceneTargets(stage: Page) {
  const hide = stage.locator(HIDE);
  await expect(hide).toBeVisible();
  const pills = await stage.locator(PILLS).all();
  // The song browser's row: Queue, People and Setup (no Add songs, #248).
  expect(pills.length).toBeGreaterThanOrEqual(3);
  return [
    { name: "Hide", point: await centre(hide) },
    ...(await Promise.all(
      pills.map(async (pill, index) => ({
        name: `pill ${String(index)}`,
        point: await centre(pill),
      })),
    )),
  ];
}

test("the Setup menu lies over the join card's Hide pill", async ({
  stage,
}) => {
  await newParty(stage);
  const hide = stage.locator(HIDE);
  await expect(hide).toBeVisible();
  await stage.getByRole("button", { name: "Setup" }).click();
  const menu = stage.getByRole("menu", { name: "Setup" });
  await expect(menu).toBeVisible();
  await settled(menu);
  // The menu runs down over the card's top edge, where Hide sits.
  const menuBox = await menu.boundingBox();
  const hideBox = await hide.boundingBox();
  expect(menuBox && hideBox).toBeTruthy();
  if (!menuBox || !hideBox) return;
  const point = {
    x: Math.max(menuBox.x, hideBox.x) + 4,
    y: Math.max(menuBox.y, hideBox.y) + 4,
  };
  expect(point.x).toBeLessThan(menuBox.x + menuBox.width);
  expect(point.y).toBeLessThan(menuBox.y + menuBox.height);
  expect(point.x).toBeLessThan(hideBox.x + hideBox.width);
  expect(point.y).toBeLessThan(hideBox.y + hideBox.height);
  expect(await hitAt(stage, point, "[role=menu]")).toBe(true);
});

/** How each overlay opens from the song browser. */
const OVERLAYS: readonly {
  id: string;
  open: (stage: Page) => Promise<void>;
}[] = [
  { id: "songs", open: (stage) => stage.keyboard.press("s") },
  { id: "queue", open: (stage) => stage.keyboard.press("q") },
  { id: "people", open: (stage) => stage.keyboard.press("p") },
  ...(
    [
      ["mics", "Mics"],
      ["calibrateMics", "Calibrate mics"],
      ["avSync", "Check A/V sync"],
      ["downloads", "Downloads"],
      ["options", "Options"],
    ] as const
  ).map(([id, entry]) => ({
    id,
    open: async (stage: Page) => {
      await stage.getByRole("button", { name: "Setup" }).click();
      await stage.getByRole("menuitem", { name: entry, exact: true }).click();
    },
  })),
];

test("an open overlay covers the join card and the Stage menu", async ({
  stage,
}) => {
  await newParty(stage);
  const targets = await sceneTargets(stage);
  for (const { id, open } of OVERLAYS) {
    await open(stage);
    const overlay = stage.locator(`[data-overlay=${id}]`);
    await expect(overlay).toBeVisible();
    await settled(overlay.locator("[role=dialog]").first());
    for (const { name, point } of targets) {
      expect(
        await hitAt(stage, point, `[data-overlay=${id}]`),
        `${name} under ${id}`,
      ).toBe(true);
    }
    await stage.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
  }
});
