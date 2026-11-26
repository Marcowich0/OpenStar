import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";

import {
  becomeStageWithPin,
  expect,
  FAKE_MIC,
  newParty,
  STAGE_VIEWPORT,
  test,
} from "../fixtures";
import { writeSungWav } from "../wav";

// The two Phone flows of the end-to-end suite (spec #58, ticket #229). Each
// starts by becoming the Stage with the Admin PIN on the pad, in a browser
// the Stage has never seen. Together they visit the Stage route (`/stage`)
// and the Phone route (`/`, by the number pad and by the QR link `?join=`)
// of spec #56's route table; flow 2 also opens the Admin area's Profiles.
//
// Flow 1: two Phones join by Join code. One hears a sung 440 Hz tone, the
// other digital silence. The first queues the Steady Tone Song from its
// Songs tab with both Players in the Line-up (a solo Song: they share its
// one Voice), both turn their mics on, and the Song plays to the results.
// Every scored Note of Steady Tone is on pitch class A, so the singing Phone
// scores inside SUNG_BAND and the silent one 0.
//
// Flow 2: a Guest joins on a Phone with a name, a picture and a colour; a
// new Profile is created from a second Phone and listed in the Admin area.

/**
 * The singing Player's Score. The sung WAV (`writeSungWav`) breathes for
 * 150 ms of every 600 ms, so some Beats are unvoiced and a pipeline that
 * works lands under 10000: about 7600 to 8100 on the pinned Chromium with
 * the default Phone Mic delay. The floor needs most Beats hit: readings that
 * never arrive, arrive outside their Beats (a broken clock sync or Mic
 * delay) or read the wrong pitch fall far below it (the same WAV three
 * semitones off, on C, scores 0; one semitone off still counts at Medium).
 * The ceiling catches a scorer that counts every Beat as hit.
 */
const SUNG_BAND = { min: 6000, max: 9500 } as const;

/** How long the Steady Tone Song takes to its results, with a slow machine's margin. */
const SONG_TO_RESULTS_MS = 60_000;

/** Makes a desktop browser the Stage through the Admin PIN pad. */
async function stageWithPin(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; stage: Page }> {
  const context = await browser.newContext({
    viewport: STAGE_VIEWPORT,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const stage = await context.newPage();
  await becomeStageWithPin(stage);
  return { context, stage };
}

/** A Profile with a name no other test uses (Profiles outlive a test). */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: { name, avatar: { kind: "builtIn", key: "star" }, favouriteColour },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/** Joins on `/` by typing the Join code on the pad, as the Profile `name`. */
async function joinByPad(phone: Page, code: string, name: string) {
  await phone.goto("/");
  await expect(
    phone.getByRole("heading", { name: "Join the Party" }),
  ).toBeVisible();
  for (const digit of code)
    await phone.getByRole("button", { name: digit, exact: true }).click();
  await expect(
    phone.getByRole("heading", { name: "Who's singing?" }),
  ).toBeVisible();
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

interface Member {
  memberId: number;
  colour: string;
  identity: {
    kind: string;
    name?: string;
    avatar?: { kind: string; key: string };
  };
}

/** The Party as a new connection of `page` is told it (`liveState`). */
async function liveParty(
  page: Page,
): Promise<{ members: Member[]; queue: { requestId: number }[] }> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            party?: { members: Member[]; queue: { requestId: number }[] };
          };
          if (message.type === "liveState" && message.party) {
            socket.close();
            resolve(message.party);
          }
        };
      }),
  );
}

/** Sends `message` as the Phone, over a second socket of its page (clean-up only). */
async function sendFromPhone(phone: Page, message: object): Promise<void> {
  await phone.evaluate(
    (message) =>
      new Promise<void>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as { type: string };
          if (reply.type === "phoneStatus")
            socket.send(JSON.stringify(message));
          if (reply.type === "rejected") reject(new Error(String(event.data)));
          if (reply.type === "partyChanged") {
            socket.close();
            resolve();
          }
        };
      }),
    message,
  );
}

/**
 * Picks the form's radio named `name` from the keyboard: the swatch and the
 * avatar drawn over each radio take a pointer's click.
 */
async function pick(phone: Page, name: string) {
  const radio = phone.getByRole("radio", { name, exact: true });
  await radio.focus();
  await phone.keyboard.press("Space");
  await expect(radio).toBeChecked();
}

/** Taps Turn on my mic in the takeover and waits for readings to leave. */
async function turnOnMic(phone: Page) {
  const turnOn = phone.getByRole("button", { name: "Turn on my mic" });
  await expect(turnOn).toBeVisible();
  // The button breathes, so it is never "stable" for a plain click.
  await turnOn.click({ force: true });
  await expect(phone.getByText("Mic is on")).toBeVisible();
  // Readings leave once the clock synced with the Stage (about 94 a second).
  const rate = phone.locator("[data-readings-per-second]");
  await expect
    .poll(
      async () => Number(await rate.getAttribute("data-readings-per-second")),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(60);
}

test("flow 1: two Phones join by code, sing Steady Tone together, and the results show the sung Score in its band and the silent one 0", async ({
  browser,
  baseURL,
  openPhone,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const { context, stage } = await stageWithPin(browser, baseURL);
  const code = await newParty(stage);
  const singer = await createProfile(request, "Singer", "teal");
  const quiet = await createProfile(request, "Quiet", "grape");

  const sung = await writeSungWav(testInfo.outputPath("sung-440.wav"), 440, 6);
  const singing = await openPhone({ wav: sung });
  await joinByPad(singing, code, singer);
  const silent = await openPhone({ wav: FAKE_MIC.silence });
  await joinByPad(silent, code, quiet);

  // The singing Phone queues Steady Tone from its Songs tab, with both.
  await singing.getByRole("button", { name: "Add Steady Tone" }).click();
  const sheet = singing.getByRole("dialog", { name: "Steady Tone" });
  const who = sheet.getByRole("group", { name: /Who sings it\?/ });
  await expect(
    who.getByRole("button", { name: new RegExp(`^${singer}`) }),
  ).toHaveAttribute("aria-pressed", "true");
  const partner = who.getByRole("button", { name: new RegExp(`^${quiet}`) });
  await partner.click();
  await expect(partner).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Add to the Queue" }).click();
  await expect(sheet).toHaveCount(0);

  const frame = stage.locator("[data-stage-frame]");
  let playing = false;
  let requestId = -1;
  try {
    await expect(frame).toHaveAttribute("data-scene", "lineUp");
    requestId = (await liveParty(stage)).queue[0]?.requestId ?? -1;
    // Both Players are seated, each on its own Phone: both share P1.
    await expect(stage.getByRole("group", { name: singer })).toBeVisible();
    await expect(stage.getByRole("group", { name: quiet })).toBeVisible();

    // Each seated Phone shows its mic takeover; both turn their mics on.
    await turnOnMic(singing);
    await turnOnMic(silent);

    const start = stage.getByRole("button", { name: "Start" });
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
      { timeout: SONG_TO_RESULTS_MS },
    );
    // Space presses Start (the Line-up's key).
    await stage.keyboard.press(" ");
    playing = true;
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect(
      singing.getByRole("heading", { name: "Sing it!" }),
    ).toBeVisible();

    const response = await round;
    playing = false;
    expect(response.status()).toBe(201);
    const stored = (await response.json()) as {
      round: { ended: string };
      results: { players: { name: string; total: number; place: number }[] };
    };
    expect(stored.round.ended).toBe("played");
    const totals = new Map(
      stored.results.players.map((p) => [p.name, p.total]),
    );
    const sungTotal = totals.get(singer) ?? -1;
    testInfo.annotations.push({
      type: "sung Score",
      description: String(sungTotal),
    });
    expect(sungTotal).toBeGreaterThanOrEqual(SUNG_BAND.min);
    expect(sungTotal).toBeLessThanOrEqual(SUNG_BAND.max);
    expect(totals.get(quiet)).toBe(0);

    // The Stage's results screen: the singer first, the silent Player 0.
    await expect(frame).toHaveAttribute("data-scene", "results");
    const bars = stage.getByTestId("results-players").getByRole("listitem");
    await expect(bars).toHaveCount(2);
    await expect(bars.nth(0)).toContainText(singer);
    await expect(bars.nth(0)).toContainText("Place 1");
    await expect(bars.nth(0)).toContainText(String(sungTotal));
    await expect(bars.nth(1)).toContainText(quiet);
    await expect(bars.nth(1)).toContainText("Place 2");
    // Each Phone shows its own Player's Score after the Song.
    await expect(
      singing
        .getByRole("main", { name: "After the Song" })
        .getByTestId("after-score"),
    ).toHaveText(String(sungTotal));
    await expect(
      silent
        .getByRole("main", { name: "After the Song" })
        .getByTestId("after-score"),
    ).toHaveText("0");

    // The Queue is empty: Done (focused) goes back to the song browser.
    await expect(stage.getByRole("button", { name: "Done" })).toBeFocused();
    await stage.keyboard.press("Enter");
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
  } finally {
    if (playing)
      await sendFromPhone(singing, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
    await context.close();
  }
});

test("flow 2: a Guest joins with a name, picture and colour, and a Profile created on a Phone is listed in the Admin area", async ({
  browser,
  baseURL,
  openPhone,
}) => {
  test.setTimeout(90_000);
  const { context, stage } = await stageWithPin(browser, baseURL);
  try {
    const code = await newParty(stage);
    const suffix = String(Date.now() % 100000);

    // A Guest joins from the QR link with the form.
    const guestName = `Guest ${suffix}`;
    const guestPhone = await openPhone();
    await guestPhone.goto(`/?join=${code}`);
    await expect(
      guestPhone.getByRole("heading", { name: "Who's singing?" }),
    ).toBeVisible();
    await guestPhone.getByRole("button", { name: "I'm a Guest" }).click();
    await expect(
      guestPhone.getByRole("heading", { name: "New Guest" }),
    ).toBeVisible();
    await guestPhone.getByRole("textbox", { name: "Name" }).fill(guestName);
    await pick(guestPhone, "Lime");
    await pick(guestPhone, "Picture 16");
    await guestPhone
      .getByRole("button", { name: `Join as ${guestName}` })
      .click();
    await expect(guestPhone.getByRole("tab", { name: "Songs" })).toBeVisible();
    await guestPhone.getByRole("button", { name: `Me: ${guestName}` }).click();
    await expect(
      guestPhone.getByText("Guest for tonight · Lime"),
    ).toBeVisible();
    const guest = (await liveParty(stage)).members.find(
      (m) => m.identity.name === guestName,
    );
    expect(guest).toMatchObject({
      colour: "lime",
      identity: { kind: "guest", avatar: { kind: "builtIn", key: "cat" } },
    });

    // A new Profile is created from a second Phone, by the pad.
    const profileName = `Kept ${suffix}`;
    const profilePhone = await openPhone();
    await profilePhone.goto("/");
    for (const digit of code)
      await profilePhone
        .getByRole("button", { name: digit, exact: true })
        .click();
    await profilePhone.getByRole("button", { name: "New Profile" }).click();
    await expect(
      profilePhone.getByRole("heading", { name: "New Profile" }),
    ).toBeVisible();
    await profilePhone.getByRole("textbox", { name: "Name" }).fill(profileName);
    await pick(profilePhone, "Sky");
    await profilePhone
      .getByRole("button", { name: `Join as ${profileName}` })
      .click();
    await expect(
      profilePhone.getByRole("tab", { name: "Songs" }),
    ).toBeVisible();
    await profilePhone
      .getByRole("button", { name: `Me: ${profileName}` })
      .click();
    await expect(profilePhone.getByText("Profile · Sky")).toBeVisible();

    // The Admin area's Profiles screen lists it, never sung; not the Guest.
    const admin = await context.newPage();
    await admin.goto("/admin/profiles");
    const profiles = admin.getByRole("list", { name: "Profiles" });
    const row = profiles.getByRole("listitem").filter({ hasText: profileName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Never sung");
    await expect(
      profiles.getByRole("listitem").filter({ hasText: guestName }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
