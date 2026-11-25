import { expect, test } from "../fixtures";

// The tracer: the built binary serves the app, and both kinds of screen
// complete the walking skeleton's WebSocket round trip (#59).
test("a Stage page completes the WebSocket round trip", async ({ stage }) => {
  await stage.goto("/stage");
  await expect(stage.getByTestId("round-trip")).toHaveText(
    "WebSocket: complete",
  );
});

test("a Phone page completes the WebSocket round trip", async ({
  openPhone,
}) => {
  const phone = await openPhone();
  await phone.goto("/");
  await expect(phone.getByTestId("round-trip")).toHaveText(
    "WebSocket: complete",
  );
});
