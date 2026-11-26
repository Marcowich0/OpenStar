import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

// The Stage plays the head's Request (#164): Start on the Line-up switches
// to the sing scene and the Song plays from its start; Pause, Resume,
// Restart, End and Skip from a Remote reach the Stage's playback through the
// server; an ended Song's round is stored and its results shown (#175). The
// Stage's own pause menu (#217) shows whenever the Song is paused and drives
// the same controls. A Phone sends its commands over a second socket of its
// own page, as `line-up.spec.ts` does.

interface Snapshot {
  queue: { requestId: number }[];
  playing: { requestId: number; paused: boolean } | null;
  results: { requestId: number; ended: string } | null;
}

/** Sends `message` as the Phone and returns the Party it changed. */
async function sendFromPhone(phone: Page, message: object): Promise<Snapshot> {
  return phone.evaluate(
    (message) =>
      new Promise<Snapshot>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: Snapshot;
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

async function createProfile(
  request: APIRequestContext,
): Promise<{ id: number; name: string }> {
  const name = `Sings ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "star" },
      favouriteColour: "teal",
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number; name: string };
}

async function songId(request: APIRequestContext, path: string) {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === path);
  if (!song) throw new Error(`the fixture Library has no ${path}`);
  return song.id;
}

/** The sing scene's one media element: its position and whether it plays. */
async function media(stage: Page) {
  return stage.evaluate(() =>
    [...document.querySelectorAll("audio, video")].map((m) => {
      const element = m as HTMLMediaElement;
      return {
        tag: element.tagName,
        time: element.currentTime,
        playing: !element.paused,
      };
    }),
  );
}

async function mediaTime(stage: Page): Promise<number> {
  return (await media(stage))[0]?.time ?? -1;
}

/** A Party with the steady-tone Song at the head, its Phone's Profile seated. */
async function partyWithRequest(
  stage: Page,
  openPhone: () => Promise<Page>,
  request: APIRequestContext,
) {
  const code = await newParty(stage);
  const profile = await createProfile(request);
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: profile.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  const party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: await songId(request, FIXTURE_SONGS.steadyTone),
    requestedPlayers: null,
  });
  const requestId = party.queue[0]?.requestId ?? -1;
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");
  // The requester's Profile is prefilled on its own Phone.
  const start = stage.getByRole("button", { name: "Start" });
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  return { phone, requestId, frame, profile };
}

test("Start plays the head's Song on the sing scene; Pause, Resume, Restart and Skip from a Remote act on it", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(90_000);
  const { phone, requestId, frame, profile } = await partyWithRequest(
    stage,
    openPhone,
    request,
  );
  let skipped = false;
  try {
    // Space presses Start (the Line-up's key; a pointer click waits on the
    // button's animations).
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect(stage.locator('[data-sing-scene="singing"]')).toBeVisible();
    await expect(
      stage.locator("[data-sing-screen][data-painted]"),
    ).toBeVisible();
    // The lane header names the seated Player.
    await expect(stage.locator("[data-lane-header]")).toContainText(
      profile.name,
    );

    // The Song plays from its start (#START is unset: 0), in one element.
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(1);
    const playing = await media(stage);
    expect(playing).toEqual([
      expect.objectContaining({ tag: "AUDIO", playing: true }),
    ]);
    const before = await mediaTime(stage);
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(before + 0.3);

    // Pause from the Phone freezes it, and the Stage shows its pause menu.
    await sendFromPhone(phone, {
      type: "controlSong",
      requestId,
      control: "pause",
    });
    await expect(stage.getByRole("dialog", { name: "Paused" })).toBeVisible();
    await expect.poll(async () => (await media(stage))[0]?.playing).toBe(false);
    const paused = await mediaTime(stage);
    await stage.waitForTimeout(400);
    expect(await mediaTime(stage)).toBe(paused);

    // Resume counts 3-2-1 over the frozen frame, then plays on.
    await sendFromPhone(phone, {
      type: "controlSong",
      requestId,
      control: "resume",
    });
    await expect(stage.getByTestId("resume-countdown")).toHaveAttribute(
      "data-count",
      "3",
    );
    await expect(stage.getByRole("dialog", { name: "Paused" })).toHaveCount(0);
    expect(await mediaTime(stage)).toBe(paused);
    await expect(stage.getByTestId("resume-countdown")).toHaveCount(0, {
      timeout: 6000,
    });
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(paused + 0.3);

    // Restart goes back to the start and plays.
    const restartedFrom = await mediaTime(stage);
    await sendFromPhone(phone, {
      type: "controlSong",
      requestId,
      control: "restart",
    });
    await expect.poll(() => mediaTime(stage)).toBeLessThan(restartedFrom);
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(0.3);

    // Skip stops the Song, the Stage reports the skipped round once, and
    // the Party moves on (an empty Queue: the song browser).
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
    );
    await sendFromPhone(phone, {
      type: "controlSong",
      requestId,
      control: "skip",
    });
    skipped = true;
    const response = await round;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      requestId,
      ended: "skipped",
      scores: [],
    });
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
    expect(await media(stage)).toEqual([]);
  } finally {
    if (!skipped)
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
  }
});

test("End stops the Song: the Stage stores the ended round and the Stage and the Phone show its results", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(60_000);
  const { phone, requestId, frame, profile } = await partyWithRequest(
    stage,
    openPhone,
    request,
  );
  let ended = false;
  try {
    // Space presses Start (the Line-up's key; a pointer click waits on the
    // button's animations).
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(0.5);

    // End: the Stage sends the round's outcome once and the server answers
    // with the stored round and its results. This Phone never turned its
    // mic on, so no Pitch reading reaches the scorer and the Score is 0
    // (phone-mic.spec.ts sings).
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
    );
    await sendFromPhone(phone, {
      type: "controlSong",
      requestId,
      control: "end",
    });
    ended = true;
    const response = await round;
    expect(response.status()).toBe(201);
    const stored = (await response.json()) as {
      round: {
        ended: string;
        records: { player: { profileId?: number }; unfinished: boolean }[];
      };
      results: { players: { name: string; total: number; place: number }[] };
    };
    expect(stored.round.ended).toBe("ended");
    expect(stored.round.records).toEqual([
      expect.objectContaining({
        player: { kind: "profile", profileId: profile.id },
        unfinished: true,
      }),
    ]);
    expect(stored.results.players).toEqual([
      expect.objectContaining({ name: profile.name, total: 0, place: 1 }),
    ]);

    // The Stage shows the results; the Phone shows its own Player's.
    await expect(frame).toHaveAttribute("data-scene", "results");
    expect(await media(stage)).toEqual([]);
    // One bar: place 1, the total 0, the lowest Rank title; the Player did
    // not finish, so the banner replaces the artist.
    const bar = stage.getByTestId("results-players").getByRole("listitem");
    await expect(bar).toHaveCount(1);
    await expect(bar).toContainText(profile.name);
    await expect(bar).toContainText("Place 1");
    await expect(bar).toContainText("Shower Singer");
    await expect(bar).toContainText("unfinished");
    await expect(
      stage.getByText("Ended early, so no high scores this time"),
    ).toBeVisible();
    // The Phone shows its Player's own result (#176) until Done, which
    // opens the Remote's Stage tab with the results card.
    const own = phone.getByRole("main", { name: "After the Song" });
    await expect(own.getByTestId("after-score")).toHaveText("0");
    await expect(own).toContainText("Ended early");
    await own.getByRole("button", { name: "Done" }).click();
    await expect(
      phone.getByRole("tab", { name: "Stage", selected: true }),
    ).toBeVisible();
    const mine = phone.getByTestId("my-result");
    await expect(mine).toContainText("Your Score: 0");
    await expect(mine).toContainText("Ended early");

    // Storing the record set the Profile's last sung.
    const after = (await (
      await request.get(`/api/profiles/${String(profile.id)}`)
    ).json()) as { lastSungAt: number | null };
    expect(after.lastSungAt).not.toBeNull();

    // The Queue is empty, so the results lead on with Done, focused: Enter
    // goes back to the song browser.
    const done = stage.getByRole("button", { name: "Done" });
    await expect(done).toBeFocused();
    await stage.keyboard.press("Enter");
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
    ended = false;
  } finally {
    if (ended) await sendFromPhone(phone, { type: "closeResults" });
    else
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
  }
});

test("The Stage's pause menu: Space opens it, Esc resumes with the countdown, a held End shows the results", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(60_000);
  const { phone, requestId, frame } = await partyWithRequest(
    stage,
    openPhone,
    request,
  );
  let ended = false;
  try {
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(0.5);

    // Space pauses: the menu over the frozen frame, Resume focused.
    await stage.keyboard.press(" ");
    const menu = stage.getByRole("dialog", { name: "Paused" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Resume" })).toBeFocused();
    for (const name of [
      "Restart",
      "Skip to the next Song",
      "End and show results",
    ]) {
      await expect(menu.getByRole("button", { name })).toBeVisible();
    }
    await expect(menu).toContainText(
      "Restart, Skip and End: hold Enter or press and hold",
    );
    await expect.poll(async () => (await media(stage))[0]?.playing).toBe(false);
    const paused = await mediaTime(stage);
    // Settled, for the notes' screenshot (an attachment of this test).
    await stage.waitForTimeout(500);
    await stage.screenshot({ path: test.info().outputPath("pause-menu.png") });

    // Esc on the menu resumes: 3-2-1 over the frozen frame, then it plays.
    await stage.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    const countdown = stage.getByTestId("resume-countdown");
    await expect(countdown).toHaveAttribute("data-count", "3");
    await expect(countdown).toHaveAttribute("data-count", "2");
    await stage.waitForTimeout(500);
    await stage.screenshot({ path: test.info().outputPath("countdown.png") });
    expect(await mediaTime(stage)).toBe(paused);
    await expect(countdown).toHaveCount(0, { timeout: 4000 });
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(paused + 0.2);

    // Esc pauses too; a short Enter on End does nothing, a held one ends.
    await stage.keyboard.press("Escape");
    await expect(menu).toBeVisible();
    const end = menu.getByRole("button", { name: "End and show results" });
    await end.focus();
    await stage.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await holdToConfirm(end);
    ended = true;
    await expect(frame).toHaveAttribute("data-scene", "results");
    expect(await media(stage)).toEqual([]);
    await stage.getByRole("button", { name: "Done" }).press("Enter");
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
    ended = false;
  } finally {
    if (ended) await sendFromPhone(phone, { type: "closeResults" });
    else
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
  }
});

test("A held Skip on the pause menu goes straight on with no results; a held Restart plays from the start", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(60_000);
  const { phone, requestId, frame } = await partyWithRequest(
    stage,
    openPhone,
    request,
  );
  let skipped = false;
  try {
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(1);
    const menu = stage.getByRole("dialog", { name: "Paused" });

    // Restart from the menu: back to the start, playing, no countdown.
    await stage.keyboard.press(" ");
    await expect(menu).toBeVisible();
    const from = await mediaTime(stage);
    await holdToConfirm(menu.getByRole("button", { name: "Restart" }));
    await expect(menu).toHaveCount(0);
    await expect.poll(() => mediaTime(stage)).toBeLessThan(from);
    await expect(stage.getByTestId("resume-countdown")).toHaveCount(0);
    await expect.poll(async () => (await media(stage))[0]?.playing).toBe(true);

    // Skip, held with the mouse. Every scene the frame shows from here is
    // recorded, to see that no results scene comes between.
    await stage.evaluate(() => {
      const frame = document.querySelector("[data-stage-frame]");
      const seen: string[] = [];
      Object.assign(window, { seenScenes: seen });
      if (!frame) return;
      new MutationObserver(() => {
        seen.push(frame.getAttribute("data-scene") ?? "");
      }).observe(frame, { attributes: true, attributeFilter: ["data-scene"] });
    });
    await stage.keyboard.press(" ");
    const skip = menu.getByRole("button", { name: "Skip to the next Song" });
    await holdToConfirm(skip, { with: "pointer" });
    skipped = true;
    // The Queue is empty: the song browser, with no results scene between.
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
    expect(
      await stage.evaluate(
        () => (window as unknown as { seenScenes: string[] }).seenScenes,
      ),
    ).not.toContain("results");
  } finally {
    if (!skipped)
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
  }
});
