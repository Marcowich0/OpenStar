import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, test } from "../fixtures";

// Song playback on the Stage (#155), on the playback check page
// `/stage/playback?song=<id>` (a debug page; the sing scene's own run is
// `sing.spec.ts`): one
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

/** The readout once it has stopped moving: the same in two looks 100 ms apart. */
async function stoppedSongTime(stage: Page): Promise<number> {
  let last = NaN;
  await expect
    .poll(
      async () => {
        const now = await songTime(stage);
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [100] },
    )
    .toBe(true);
  return last;
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
  await expect.poll(() => songTime(stage)).toBeGreaterThan(before + 0.3);

  // The steady tone's audio ends after its last Note (about 10.6 s).
  await expect(stage.getByTestId("song-ended")).toHaveAttribute(
    "data-ending",
    "played",
    { timeout: 30_000 },
  );
  expect(await songTime(stage)).toBeGreaterThan(10);
});

test("pause freezes the Song, resume counts 3-2-1 first, Restart goes back to the start", async ({
  stage,
  request,
}) => {
  test.setTimeout(60_000);
  const id = await songId(request, FIXTURE_SONGS.steadyTone);
  await stage.goto(`/stage/playback?song=${String(id)}`);
  await expect(stage.locator("[data-sing-screen][data-painted]")).toBeVisible();
  await stage.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => songTime(stage)).toBeGreaterThan(1);

  await stage.getByRole("button", { name: "Pause" }).click();
  await expect(stage.getByRole("status")).toHaveText("Paused");
  // The clock freezes on the element's `pause` event, a moment after the
  // press; the readout follows on the next frame. Then it stays: a clock
  // standing still can only be shown by looking again a while later.
  const paused = await stoppedSongTime(stage);
  await stage.waitForTimeout(700);
  expect(await songTime(stage)).toBe(paused);
  expect(
    await stage.evaluate(() => document.querySelector("audio")?.paused),
  ).toBe(true);

  // The countdown runs over the frozen frame, then the Song plays on from
  // where it stopped.
  await stage.getByRole("button", { name: "Resume" }).click();
  const countdown = stage.getByTestId("resume-countdown");
  await expect(countdown).toHaveAttribute("data-count", "3");
  await expect(countdown).toHaveAttribute("data-count", "2");
  expect(await songTime(stage)).toBe(paused);
  await expect(countdown).toHaveAttribute("data-count", "1");
  expect(await songTime(stage)).toBe(paused);
  await expect(countdown).toBeHidden({ timeout: 3_000 });
  await expect.poll(() => songTime(stage)).toBeGreaterThan(paused);
  expect(await songTime(stage)).toBeLessThan(paused + 1);

  // Restart: back to the start (the fixture has no #START), and it plays.
  await expect.poll(() => songTime(stage)).toBeGreaterThan(paused + 0.5);
  await stage.getByRole("button", { name: "Restart" }).click();
  await expect.poll(() => songTime(stage)).toBeLessThan(1);
  await expect.poll(() => songTime(stage)).toBeGreaterThan(0.3);
});
