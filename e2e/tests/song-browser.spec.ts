import { expect, newParty, test } from "../fixtures";

// The song browser (#177): with an empty Queue the Stage rests on the cover
// carousel; ← and → step the selected Song and Sing! (here Enter on the
// selected cover) adds it as a Request from the Stage, whose Line-up shows.

test("the Stage picks a Song in the carousel and Sing! shows its Line-up", async ({
  stage,
}) => {
  await newParty(stage);
  // A fresh Stage: New party's People overlay gives the focus back to its opener.
  await stage.reload();
  const frame = stage.locator("[data-stage-frame]");
  const title = () => stage.getByTestId("song-info").getByRole("heading");

  await expect(stage.getByTestId("stage-logo")).toHaveText("OpenStar");
  await expect(stage.getByRole("button", { name: "Sing!" })).toBeVisible();
  await expect(title()).not.toBeEmpty();
  const first = (await title().textContent()) ?? "";

  // The selected cover holds the focus; → steps to the next Song.
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();
  await stage.keyboard.press("ArrowRight");
  await expect(title()).not.toHaveText(first);
  const picked = (await title().textContent()) ?? "";
  await stage.keyboard.press("ArrowLeft");
  await expect(title()).toHaveText(first);
  await stage.keyboard.press("ArrowRight");
  await expect(title()).toHaveText(picked);

  await stage.keyboard.press("Enter");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");
  await expect(stage.getByRole("heading", { level: 1 })).toHaveText(picked);

  // Leave the Stage on an empty Queue for the next test.
  await newParty(stage);
});
