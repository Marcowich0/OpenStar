import type { Page } from "@playwright/test";

import { expect, newParty, test } from "../fixtures";

// Search on the song browser (#179): `/` opens the box with the Remote's
// filter chips, typing narrows the carousel, ↓ moves to the chips and the
// carousel, Esc clears and closes. Enter on the best-score chip opens the
// Song detail with its High score tables.

const title = (stage: Page) =>
  stage.getByTestId("song-info").getByRole("heading");

test("the host searches the Library with / and Esc clears it", async ({
  stage,
}) => {
  await newParty(stage);
  await stage.reload();
  const box = stage.getByRole("searchbox", { name: "Search songs or artists" });
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();

  await stage.keyboard.press("/");
  await expect(box).toBeFocused();
  const filters = stage.getByRole("group", { name: "Filters" });
  await expect(filters.getByRole("button", { name: "All" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "Duets" })).toBeVisible();

  // Hovering a cover leaves the focus (and the typing) in the box.
  await stage.getByTestId("carousel-selected").hover();
  await stage.keyboard.type("two voi");
  await expect(box).toHaveValue("two voi");
  await expect(title(stage)).toHaveText("Two Voices");
  await expect(stage.locator('[data-testid^="carousel-cover-"]')).toHaveCount(
    1,
  );

  await stage.keyboard.press("ArrowDown");
  await expect(filters.getByRole("button", { name: "All" })).toBeFocused();
  await stage.keyboard.press("ArrowDown");
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();

  await stage.keyboard.press("/");
  await stage.keyboard.press("Control+A");
  await stage.keyboard.type("nothing like this");
  await expect(stage.getByText("No Songs match")).toBeVisible();
  await expect(stage.getByTestId("carousel-selected")).toHaveCount(0);

  await stage.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();
  expect(
    await stage.locator('[data-testid^="carousel-cover-"]').count(),
  ).toBeGreaterThan(1);
});

test("the Duets chip narrows the Songs overlay's carousel too", async ({
  stage,
}) => {
  await newParty(stage);
  await stage.reload();
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();
  await stage.keyboard.press("/");
  const filters = stage.getByRole("group", { name: "Filters" });
  await expect(filters.getByRole("button", { name: "Duets" })).toBeVisible();
  await stage.keyboard.press("ArrowDown");
  await stage.keyboard.press("ArrowRight");
  const duets = filters.getByRole("button", { name: "Duets" });
  await expect(duets).toBeFocused();
  await stage.keyboard.press("Enter");
  await expect(duets).toHaveAttribute("aria-pressed", "true");
  await expect(title(stage)).toHaveText("Two Voices");

  await stage.keyboard.press("s");
  const songs = stage.getByRole("dialog", { name: "Songs" });
  await expect(songs.getByTestId("songs-overlay-title")).toHaveText(
    "Two Voices",
  );
  await expect(songs.locator('[data-testid^="carousel-cover-"]')).toHaveCount(
    1,
  );
  // The overlay's `/` opens the same search; Esc clears it there first,
  // and the Song found stays selected.
  await songs.getByTestId("carousel-selected").focus();
  await stage.keyboard.press("Escape");
  await expect(stage.getByRole("searchbox")).toHaveCount(0);
  expect(
    await songs.locator('[data-testid^="carousel-cover-"]').count(),
  ).toBeGreaterThan(1);
  await expect(songs.getByTestId("songs-overlay-title")).toHaveText(
    "Two Voices",
  );
  await stage.keyboard.press("Escape");
  await expect(songs).toHaveCount(0);
});

// The e2e server has no route to store a round, so the Song list and the
// tables are answered here; the Stage's keys and the overlay are real.
test("Enter on the best-score chip opens the Song detail, Esc closes it", async ({
  stage,
}) => {
  const holder = (
    profileId: number,
    name: string,
    favouriteColour: string,
  ) => ({
    profileId,
    name,
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour,
  });
  await stage.route(/\/api\/songs(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const list = (await response.json()) as {
      songs: { title: string; topHighScore: unknown }[];
    };
    for (const song of list.songs)
      if (song.title === "Two Voices")
        song.topHighScore = {
          total: 9480,
          holder: holder(901, "Sofie", "sky"),
        };
    await route.fulfill({ response, json: list });
  });
  await stage.route(/\/api\/songs\/\d+\/high-scores$/, (route) =>
    route.fulfill({
      json: {
        tables: [0, 1].flatMap((voice) =>
          ["easy", "medium", "hard"].map((difficulty) => ({
            voice,
            difficulty,
            entries:
              difficulty !== "medium"
                ? []
                : voice === 0
                  ? [
                      {
                        place: 1,
                        holder: holder(901, "Sofie", "sky"),
                        total: 9480,
                        olderTiming: false,
                      },
                      {
                        place: 2,
                        holder: holder(902, "Jonas", "tangerine"),
                        total: 7120,
                        olderTiming: true,
                      },
                    ]
                  : [
                      {
                        place: 1,
                        holder: holder(903, "Maja", "grape"),
                        total: 8800,
                        olderTiming: false,
                      },
                    ],
          })),
        ),
      },
    }),
  );
  await newParty(stage);
  await stage.reload();
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();
  await stage.keyboard.press("/");
  await stage.keyboard.type("two voices");
  await expect(title(stage)).toHaveText("Two Voices");
  await stage.keyboard.press("Escape");

  // ↓ from the cover reaches Sing!, ↑ from there the best-score chip.
  const best = stage.getByRole("button", { name: "Best 9,480 · Sofie" });
  await expect(stage.getByTestId("carousel-selected")).toBeFocused();
  await stage.keyboard.press("ArrowDown");
  await expect(stage.getByRole("button", { name: "Sing!" })).toBeFocused();
  await stage.keyboard.press("ArrowUp");
  await expect(best).toBeFocused();
  await stage.keyboard.press("Enter");
  const detail = stage.getByRole("dialog", { name: "High scores" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab", { name: "Medium" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(detail.getByRole("listitem")).toHaveCount(2);
  await expect(detail.getByText("Older timing")).toBeVisible();

  await stage.keyboard.press("ArrowLeft");
  await expect(detail.getByRole("tab", { name: "Easy" })).toBeFocused();
  await stage.keyboard.press("Enter");
  await expect(detail.getByText("No High scores yet")).toBeVisible();

  await stage.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(best).toBeFocused();
});
