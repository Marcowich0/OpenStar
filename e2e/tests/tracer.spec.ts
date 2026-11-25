import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The tracer: the built binary serves the app, and both kinds of screen
// complete the walking skeleton's WebSocket round trip (#59): each sends a
// change over its WebSocket and shows the state the server sends back.

async function roundTrip(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId("live-connection")).toHaveText(
    "WebSocket: open",
  );
  await page.getByLabel("Placeholder").fill(text);
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByTestId("placeholder")).toHaveText(text);
}

test("a Stage page and a Phone page each complete the WebSocket round trip", async ({
  stage,
  openPhone,
}) => {
  await stage.goto("/stage");
  await roundTrip(stage, "sent by the Stage");

  const phone = await openPhone();
  await phone.goto("/");
  await roundTrip(phone, "sent by a Phone");

  // Both screens share the one live state the server owns.
  await expect(stage.getByTestId("placeholder")).toHaveText("sent by a Phone");
});
