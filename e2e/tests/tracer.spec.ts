import { expect, test } from "../fixtures";

// The tracer: the built binary serves the app, and both kinds of screen
// complete the WebSocket round trip: the Stage's page becomes the Stage and
// shows its Party's Join code on the song browser, a Phone's page is told the
// same Party, and New party (held in the Stage's People overlay) reaches both.

const joinCode = /^\d{4}$/;

test("the Stage and a Phone share one Party, and New party reaches both", async ({
  stage,
  openPhone,
}) => {
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "songBrowser",
  );
  await expect(stage.getByTestId("party-join-code")).toHaveText(joinCode);
  const code = await stage.getByTestId("party-join-code").textContent();

  const phone = await openPhone();
  await phone.goto("/");
  await expect(phone.getByTestId("live-connection")).toHaveText(
    "WebSocket: open",
  );
  await expect(phone.getByTestId("party-join-code")).toHaveText(code ?? "");
  await expect(phone.getByRole("button", { name: "New party" })).toHaveCount(0);

  // P opens People; New party needs a hold of Enter.
  await stage.keyboard.press("p");
  const people = stage.getByRole("dialog", { name: "Tonight's Party" });
  await expect(people).toBeVisible();
  await people.getByRole("button", { name: "New party" }).focus();
  await stage.keyboard.down("Enter");
  await stage.waitForTimeout(900);
  await stage.keyboard.up("Enter");
  await expect(people.getByTestId("people-join-code")).not.toHaveText(
    `Join with ${code ?? ""}`,
  );
  await stage.keyboard.press("Escape");
  await expect(people).toHaveCount(0);

  await expect(stage.getByTestId("party-join-code")).not.toHaveText(code ?? "");
  await expect(stage.getByTestId("party-join-code")).toHaveText(joinCode);
  const next = await stage.getByTestId("party-join-code").textContent();
  await expect(phone.getByTestId("party-join-code")).toHaveText(next ?? "");
});
