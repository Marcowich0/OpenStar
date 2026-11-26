import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// Separate audio and video files (#212): the fixture Song's audio plays and
// is the clock; its muted video follows at audio position + #VIDEOGAP (−1.5 s),
// behind the background until it reaches position 0. Pause, Resume and
// Restart keep it following, and the Song plays out to its results.

const VIDEO_GAP = -1.5;
/** How far the video may be from its target, seconds (correction runs at 50 ms). */
const IN_STEP = 0.15;

/** Sends `message` as the Phone and returns the Party it changed. */
async function sendFromPhone(
  phone: Page,
  message: object,
): Promise<{ queue: { requestId: number }[] }> {
  return phone.evaluate(
    (message) =>
      new Promise<{ queue: { requestId: number }[] }>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: { queue: { requestId: number }[] };
          };
          if (reply.type === "phoneStatus")
            socket.send(JSON.stringify(message));
          if (reply.type === "rejected") reject(new Error(String(event.data)));
          if (reply.type === "partyChanged" && reply.party) {
            socket.close();
            resolve(reply.party);
          }
        };
      }),
    message,
  );
}

async function songId(request: APIRequestContext, path: string) {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === path);
  if (!song) throw new Error(`the fixture Library has no ${path}`);
  return song.id;
}

interface MediaState {
  time: number;
  playing: boolean;
  muted: boolean;
  /** Behind the background (`invisible`). */
  hidden: boolean;
}

/** The sing scene's audio and its following video. */
function media(
  stage: Page,
): Promise<{ audio: MediaState | null; video: MediaState | null }> {
  return stage.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector<HTMLMediaElement>(selector);
      return element
        ? {
            time: element.currentTime,
            playing: !element.paused,
            muted: element.muted,
            hidden: element.classList.contains("invisible"),
          }
        : null;
    };
    return { audio: read("audio"), video: read("video") };
  });
}

/** How far the video is from audio position + #VIDEOGAP, seconds. */
async function drift(stage: Page): Promise<number> {
  const { audio, video } = await media(stage);
  if (!audio || !video) return Infinity;
  return Math.abs(video.time - (audio.time + VIDEO_GAP));
}

test("a Song with separate audio and video files plays end to end, the video following the audio", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(120_000);
  const code = await newParty(stage);
  const name = `Video ${String(Date.now() % 100000)}`;
  const profile = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "star" },
      favouriteColour: "teal",
    },
  });
  expect(profile.ok()).toBe(true);
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  const party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: await songId(request, FIXTURE_SONGS.separateVideo),
    requestedPlayers: null,
  });
  const requestId = party.queue[0]?.requestId ?? -1;
  const control = (c: string) =>
    sendFromPhone(phone, { type: "controlSong", requestId, control: c });
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");
  await expect(
    stage.getByRole("button", { name: "Start" }),
  ).not.toHaveAttribute("aria-disabled", "true");

  let atResults = false;
  try {
    // Space presses Start (a pointer click waits on the button's animations).
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");

    // The audio plays; the video is muted and waits behind the background.
    await expect
      .poll(async () => (await media(stage)).audio?.playing)
      .toBe(true);
    const early = await media(stage);
    expect(early.video?.muted).toBe(true);
    if ((early.audio?.time ?? 0) < 1.2) {
      expect(early.video).toMatchObject({ hidden: true, playing: false });
    }

    // Once the video's position reaches 0 (1.5 s into the audio) it shows
    // and plays in step with the audio.
    await expect
      .poll(async () => (await media(stage)).video?.hidden, {
        timeout: 10_000,
      })
      .toBe(false);
    expect((await media(stage)).audio?.time ?? 0).toBeGreaterThan(1.4);
    await expect.poll(() => drift(stage)).toBeLessThan(IN_STEP);
    await stage.waitForTimeout(500);
    expect(await drift(stage)).toBeLessThan(IN_STEP);

    // Pause stops both; Resume (after its 3-2-1) plays both on, in step.
    await control("pause");
    await expect
      .poll(async () => {
        const { audio, video } = await media(stage);
        return [audio?.playing, video?.playing];
      })
      .toEqual([false, false]);
    await control("resume");
    await expect(stage.getByTestId("resume-countdown")).toHaveCount(0, {
      timeout: 6000,
    });
    await expect
      .poll(async () => {
        const { audio, video } = await media(stage);
        return [audio?.playing, video?.playing];
      })
      .toEqual([true, true]);
    await expect.poll(() => drift(stage)).toBeLessThan(IN_STEP);

    // Restart: back behind the background before 1.5 s, then it follows again.
    await control("restart");
    await expect
      .poll(async () => (await media(stage)).video?.hidden)
      .toBe(true);
    await expect
      .poll(async () => (await media(stage)).video?.hidden, {
        timeout: 10_000,
      })
      .toBe(false);
    await expect.poll(() => drift(stage)).toBeLessThan(IN_STEP);

    // The Song plays out to its end, and the Stage shows the results.
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    expect((await round).request().postDataJSON()).toMatchObject({
      requestId,
      ended: "played",
    });
    atResults = true;
    await expect(frame).toHaveAttribute("data-scene", "results");
    expect(await media(stage)).toEqual({ audio: null, video: null });
  } finally {
    if (atResults) await sendFromPhone(phone, { type: "closeResults" });
    else await control("skip").catch(() => undefined);
  }
});
