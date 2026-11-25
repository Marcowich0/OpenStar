import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, test } from "../fixtures";

// Song playback on the Stage (#155), on the minimal playback view
// `/stage/playback?song=<id>` until the sing scene plays Songs (#164): one
// media element plays a fixture Song's generated audio through the Stage's
// AudioContext, `songTime()` advances, and the Song ends with one signal.

async function songId(request: APIRequestContext, path: string) {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === path);
  if (!song) throw new Error(`no Song ${path}`);
  return song.id;
}

/** The view's `songTime()` readout, seconds. */
async function songTime(stage: Page): Promise<number> {
  return Number(
    await stage.getByTestId("song-time").getAttribute("data-song-time"),
  );
}

test("a fixture Song plays through one media element to its end", async ({
  stage,
  request,
}) => {
  test.setTimeout(60_000);
  const id = await songId(request, FIXTURE_SONGS.steadyTone);
  await stage.goto(`/stage/playback?song=${String(id)}`);
  await expect(stage.locator("[data-sing-screen][data-painted]")).toBeVisible();
  expect(await songTime(stage)).toBe(0);

  await stage.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => songTime(stage)).toBeGreaterThan(1);

  // One element plays it: an <audio> (the fixture Song has no video).
  const media = await stage.evaluate(() =>
    [...document.querySelectorAll("audio, video")].map((m) => ({
      tag: m.tagName,
      playing: !(m as HTMLMediaElement).paused,
    })),
  );
  expect(media).toEqual([{ tag: "AUDIO", playing: true }]);
  expect(
    await stage.getByTestId("song-time").getAttribute("data-audio-context"),
  ).toBe("running");

  // Song time only moves forward while it plays.
  const before = await songTime(stage);
  await stage.waitForTimeout(500);
  expect(await songTime(stage)).toBeGreaterThan(before);

  // The steady tone's audio ends after its last Note (about 10.6 s).
  await expect(stage.getByTestId("song-ended")).toHaveAttribute(
    "data-ending",
    "played",
    { timeout: 30_000 },
  );
  expect(await songTime(stage)).toBeGreaterThan(10);
});
