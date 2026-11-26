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

test("the join card's QR code opens the public address with the Join code", async ({
  stage,
}) => {
  await withPublicUrl(stage);
  const code = await newParty(stage);

  const qr = stage.getByRole("img", { name: "QR code to join the Party" });
  await expect(qr).toBeVisible();
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
  await expect(stage.getByText("Phones can't sing yet")).toBeVisible();
  await expect(
    stage.getByText(
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
