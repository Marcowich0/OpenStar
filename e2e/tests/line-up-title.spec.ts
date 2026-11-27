import type { Locator, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { createProfile, liveParty, sendFromPhone } from "../flows";

// The Line-up's header (#247): a 120-character title and artist stay on one
// line each, shorten with "…", and never run into the back pill or the Stage
// menu, at 1280 × 800 and at 1920 × 1080. The fixture Library has no long
// title, so the Stage's view of `GET /api/songs` gets one: the Song the
// Phone queues is renamed in the response, nowhere else.

/** 120 characters that start with `start` and end in a full stop. */
const long = (start: string) =>
  `${`${start}${" la".repeat(60)}`.slice(0, 119)}.`;
const LONG_TITLE = long("A Very Long Placeholder Title");
const LONG_ARTIST = long("The Placeholder Band and Friends");

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Whether `locator` is one line, cut off, with an ellipsis. */
async function shortened(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const lineHeight =
      style.lineHeight === "normal"
        ? Number.parseFloat(style.fontSize) * 1.2
        : Number.parseFloat(style.lineHeight);
    return {
      ellipsis: style.textOverflow === "ellipsis",
      oneLine:
        style.whiteSpace === "nowrap" &&
        element.getBoundingClientRect().height < lineHeight * 1.8,
      cut: element.scrollWidth > element.clientWidth,
    };
  });
}

/** Renames `songId` in every `GET /api/songs` list the Stage loads. */
async function lengthen(stage: Page, songId: number) {
  await stage.route(
    (url) => url.pathname === "/api/songs",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        songs: { id: number; title: string; artist: string }[];
      };
      for (const song of body.songs)
        if (song.id === songId) {
          song.title = LONG_TITLE;
          song.artist = LONG_ARTIST;
        }
      await route.fulfill({ response, json: body });
    },
  );
}

test("a 120-character title and artist shorten between the back pill and the Stage menu", async ({
  stage,
  openPhone,
  request,
}) => {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.steadyTone);
  if (!song) throw new Error("the fixture Library has no Steady Tone");
  await lengthen(stage, song.id);

  const code = await newParty(stage);
  const name = await createProfile(request, "Long title", "bubblegum");
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  await sendFromPhone(phone, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: null,
  });

  try {
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
    const header = stage.getByTestId("line-up-header");
    // The full title is the heading's accessible name.
    const title = header.getByRole("heading", { level: 1, name: LONG_TITLE });
    const artist = header.getByText(LONG_ARTIST, { exact: true });
    await expect(title).toBeVisible();
    await expect(artist).toBeVisible();
    const back = stage.getByTestId("browse-songs");
    const menu = stage.getByTestId("pill-row");

    for (const viewport of VIEWPORTS) {
      await stage.setViewportSize(viewport);
      // The reference frame scales on the resize: wait until it has.
      const scale = Math.min(viewport.width / 1920, viewport.height / 1080);
      await expect
        .poll(
          async () =>
            (await box(stage.locator("[data-reference-box]").first())).width,
        )
        .toBeCloseTo(1920 * scale, 0);
      for (const part of [title, artist]) {
        const at = await box(part);
        const label = `${String(viewport.width)}×${String(viewport.height)}`;
        expect(overlaps(at, await box(menu)), `${label}: menu`).toBe(false);
        expect(overlaps(at, await box(back)), `${label}: back pill`).toBe(
          false,
        );
        expect(await shortened(part), label).toEqual({
          ellipsis: true,
          oneLine: true,
          cut: true,
        });
      }
      // The cover and the text lie between the two, in the top band.
      const between = await box(header.locator(":scope > div"));
      const backBox = await box(back);
      const menuBox = await box(menu);
      expect(between.x).toBeGreaterThan(backBox.x + backBox.width);
      expect(between.x + between.width).toBeLessThan(menuBox.x);
    }
  } finally {
    await stage.setViewportSize({ width: 1920, height: 1080 });
    for (const { requestId } of (await liveParty(phone)).queue)
      await sendFromPhone(phone, { type: "removeRequest", requestId });
  }
});
