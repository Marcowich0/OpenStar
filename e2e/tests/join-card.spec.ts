import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// The join card (#178) in the song browser's corner: the QR code for
// `<join address>/?join=<code>`, the Join code and the address to type, a
// warning in place of the QR code when Phones can't reach the address, and
// Hide down to a "Join · 4821" chip that this browser remembers.

const PUBLIC_URL = "https://openstar.example.org";

/** Serves `/api/server-info` as if `OPENSTAR_PUBLIC_URL` were set. */
async function withPublicUrl(stage: Page) {
  await stage.route("**/api/server-info", async (route) => {
    const response = await route.fetch();
    const info = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...info, publicUrl: PUBLIC_URL } });
  });
}

/**
 * What on the song browser overlaps the join card: every shown cover, the
 * Song's title, artist and chips, and Sing!.
 */
async function overCard(stage: Page): Promise<string[]> {
  return stage.evaluate(() => {
    const card = document.querySelector("aside[data-layout]");
    if (card === null) return ["no join card"];
    const c = card.getBoundingClientRect();
    const things = document.querySelectorAll(
      "[data-testid^=carousel-cover-], [data-testid=song-info] h1, [data-testid=song-info] p, [data-testid=song-info] li, [data-carousel-arrows] button",
    );
    const hits: string[] = [];
    for (const el of things) {
      if (getComputedStyle(el).opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (
        r.left < c.right &&
        r.right > c.left &&
        r.top < c.bottom &&
        r.bottom > c.top
      )
        hits.push(el.getAttribute("data-testid") ?? el.tagName);
    }
    return hits;
  });
}

test("the join card's QR code opens the public address with the Join code", async ({
  stage,
}) => {
  await withPublicUrl(stage);
  const code = await newParty(stage);

  const qr = stage.getByRole("img", { name: "QR code to join the Party" });
  await expect(qr).toBeVisible();
  // In the song browser's bottom-right corner, whole on the 1920 × 1080 Stage.
  const box = await qr.boundingBox();
  expect(box?.x ?? 0).toBeGreaterThan(1300);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(1920);
  expect(box?.y ?? 0).toBeGreaterThan(400);
  // Nothing on the song browser runs under the card, whichever Song is
  // selected: the carousel keeps out of the card's lane.
  expect(await overCard(stage)).toEqual([]);
  await stage.getByTestId("carousel-selected").focus();
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowRight"]) {
    await stage.keyboard.press(key);
    // The covers slide and fade for 600 ms.
    await stage.waitForTimeout(700);
    expect(await overCard(stage)).toEqual([]);
  }
  await expect(qr).toHaveAttribute(
    "data-qr-text",
    `${PUBLIC_URL}/?join=${code}`,
  );
  await expect(stage.getByText("Go to openstar.example.org")).toBeVisible();
  await expect(stage.getByText("Pick a song from your phone")).toBeVisible();
  await expect(stage.getByText("Phones can't sing yet")).toHaveCount(0);

  // A new Party's code reaches the card (and its QR code) at once.
  const next = await newParty(stage);
  await expect(qr).toHaveAttribute(
    "data-qr-text",
    `${PUBLIC_URL}/?join=${next}`,
  );
});

test("on localhost the card warns instead, and Hide is remembered across a reload", async ({
  stage,
}) => {
  // `just e2e` serves on 127.0.0.1 with no public address: a localhost Stage.
  const code = await newParty(stage);
  // The song browser's card, not the People overlay's: for the 250 ms after
  // Escape its ghost (#260) still shows the same words, aria-hidden.
  const card = stage.getByRole("complementary");
  await expect(card.getByText("Phones can't sing yet")).toBeVisible();
  await expect(
    card.getByText(
      "Phones and other computers can't reach localhost. Set OPENSTAR_PUBLIC_URL to the server's HTTPS address.",
    ),
  ).toBeVisible();
  await expect(stage.getByRole("img", { name: /QR code/ })).toHaveCount(0);

  await stage.getByRole("button", { name: "Hide" }).click();
  const chip = stage.getByRole("button", { name: `Join · ${code}` });
  await expect(chip).toBeVisible();
  await expect(chip.getByLabel("Phones can't sing yet")).toBeVisible();
  await expect(stage.getByText("Pick a song from your phone")).toHaveCount(0);

  await stage.reload();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(stage.getByText("Pick a song from your phone")).toBeVisible();
  await stage.reload();
  await expect(stage.getByRole("button", { name: "Hide" })).toBeVisible();
});
