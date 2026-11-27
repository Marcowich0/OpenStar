import { FAKE_USDB_URL, expect, newParty, test } from "../fixtures";

// Downloads on the Stage (Marc asked for it, 2026-11-27) in real Chromium,
// against the fake USDB: the Setup menu opens the Admin area's Downloads
// section as an overlay, so `/stage` stays open under it. It fits the
// screen, its search box takes typing (S is a letter there, not the Songs
// overlay) and ↓ leaves the box, and Esc closes the video picker before the
// overlay.

test("the Stage opens Downloads from its Setup menu, in place", async ({
  stage,
}) => {
  await newParty(stage);
  await stage.request.post(`${FAKE_USDB_URL}/__fake/songs`, {
    data: [
      {
        id: 900101,
        artist: "Placeholder Band",
        title: "Stage Tune",
        genre: "Pop",
        year: 2001,
        edition: "",
        golden: false,
        language: "English",
        creator: "placeholder-creator",
        halfStars: 8,
        views: 300,
        lastChange: 1_700_000_000,
      },
    ],
  });

  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Downloads" }).click();
  const overlay = stage.getByRole("dialog", { name: "Downloads" });
  await expect(overlay).toBeVisible();
  await expect(stage).toHaveURL(/\/stage$/);

  await overlay
    .getByRole("button", { name: "Fetch the whole list again" })
    .click();
  const results = overlay.getByRole("list", { name: "USDB songs" });
  await expect(results).toContainText("Stage Tune", { timeout: 20_000 });

  // It fits the screen, with nothing sideways inside it.
  const box = await overlay.boundingBox();
  const viewport = stage.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box && viewport) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }
  expect(
    await overlay.evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth,
    ),
  ).toBe(true);

  // Typing goes to the search box; S is not the Songs overlay here.
  const search = overlay.getByRole("searchbox", {
    name: "Search USDB by artist or title",
  });
  await search.click();
  await stage.keyboard.type("stage");
  await expect(search).toHaveValue("stage");
  await expect(overlay).toBeVisible();
  await expect(stage.getByRole("dialog", { name: "Songs" })).toHaveCount(0);
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await stage.keyboard.press("ArrowDown");
  await expect(search).not.toBeFocused();

  // The video picker lies above the overlay; Esc closes it first.
  await results.getByRole("button", { name: /Stage Tune/ }).click();
  const picker = stage.getByRole("dialog", {
    name: "Choose the video for Stage Tune",
  });
  await expect(picker).toBeVisible();
  await stage.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(overlay).toBeVisible();

  await stage.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(stage).toHaveURL(/\/stage$/);
  await expect(stage.getByRole("dialog", { name: "Admin PIN" })).toHaveCount(0);
});

test("without USDB credentials the Stage says Downloads aren't set up yet, the variables folded for the owner", async ({
  stage,
}) => {
  // The e2e server has the fake's credentials: answer the status as if not.
  await stage.route("**/api/usdb/status", (route) =>
    route.fulfill({ json: { state: "credentialsMissing" } }),
  );
  await newParty(stage);

  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Downloads" }).click();
  const overlay = stage.getByRole("dialog", { name: "Downloads" });
  await expect(overlay.getByText("Downloads aren't set up yet.")).toBeVisible();
  const detail = overlay.getByText(/OPENSTAR_USDB_USERNAME/);
  await expect(detail).toBeHidden();

  const fold = overlay.getByRole("button", { name: "For the owner" });
  await fold.focus();
  await stage.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(detail).toBeVisible();
});
