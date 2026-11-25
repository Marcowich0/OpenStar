import { expect, test } from "../fixtures";

// The tracer: the built binary serves the app, and both kinds of screen
// complete the WebSocket round trip: the Stage's page becomes the Stage and
// has a Party, a Phone's page is told the same Party (its QR link's Join code
// is accepted), and after New party on the Stage only the new code is.

const joinCode = /^\d{4}$/;

test("the Stage and a Phone share one Party, and New party reaches both", async ({
  stage,
  openPhone,
}) => {
  await stage.goto("/stage");
  await expect(stage.getByTestId("live-connection")).toHaveText(
    "WebSocket: open",
  );
  await expect(stage.getByTestId("party-join-code")).toHaveText(joinCode);
  const code = await stage.getByTestId("party-join-code").textContent();

  const phone = await openPhone();
  await phone.goto(`/?join=${code ?? ""}`);
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
  await expect(phone.getByRole("button", { name: "New party" })).toHaveCount(0);

  await stage.getByRole("button", { name: "New party" }).click();
  await expect(stage.getByTestId("party-join-code")).not.toHaveText(code ?? "");
  await expect(stage.getByTestId("party-join-code")).toHaveText(joinCode);
  const next = await stage.getByTestId("party-join-code").textContent();
  await phone.goto(`/?join=${code ?? ""}`);
  await expect(phone.getByText("That code is not on the Stage")).toBeVisible();
  await phone.goto(`/?join=${next ?? ""}`);
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
});
