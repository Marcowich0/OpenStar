import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { writeSungWav } from "../wav";

// A Phone's mic reaches the Stage (#128): the Phone joins, its Profile is
// seated on its own Phone (the mic takeover shows, #167), one tap turns its
// mic on, the clock syncs with
// the Stage, and the Song plays out with that Player's Score above 0.
// Chromium's fake mic sings 440 Hz, the pitch class of every scored Note of
// the steady-tone Song. Not `FAKE_MIC.steadyTone`: the Phone's noise
// suppression (spec #50's constraints) turns a steady sine down by ~19 dB,
// to about −40 dBFS, under the Phone's −30 dBFS fallback Mic threshold.

/** Sends `message` as the Phone, over a second socket of its page. */
async function sendFromPhone(phone: Page, message: object): Promise<unknown> {
  return phone.evaluate(
    (message) =>
      new Promise((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: unknown;
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

async function createProfile(request: APIRequestContext) {
  const name = `Mic ${String(Date.now() % 100000)}`;
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

test("a Phone's mic sends readings the Stage scores: the seated Player's Score ends above 0", async ({
  stage,
  openPhone,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const code = await newParty(stage);
  const profile = await createProfile(request);
  const wav = await writeSungWav(testInfo.outputPath("sung-440.wav"), 440, 6);
  const phone = await openPhone({ wav });
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: profile.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  const party = (await sendFromPhone(phone, {
    type: "addRequest",
    songId: await songId(request, FIXTURE_SONGS.steadyTone),
    requestedPlayers: null,
  })) as { queue: { requestId: number }[] };
  const requestId = party.queue[0]?.requestId ?? -1;
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");

  let playing = false;
  try {
    // The requester is prefilled on its own Phone: that Phone is a Mic.
    const turnOn = phone.getByRole("button", { name: "Turn on my mic" });
    await expect(turnOn).toBeVisible();
    await turnOn.click({ force: true });
    await expect(phone.getByText("Mic is on")).toBeVisible();
    // Readings leave once the clock synced with the Stage: about 94 a
    // second at 48 kHz (one every 512 frames).
    const rate = phone.locator("[data-readings-per-second]");
    await expect
      .poll(
        async () => Number(await rate.getAttribute("data-readings-per-second")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(60);
    await expect(phone.getByTestId("phone-mic-diagnostics")).toContainText(
      /Detector [\d.]+ ms p50, [\d.]+ ms p95/,
    );

    // Start; the Song plays out and the Stage stores the round.
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
      { timeout: 40_000 },
    );
    await stage.keyboard.press(" ");
    playing = true;
    await expect(frame).toHaveAttribute("data-scene", "sing");
    // The mic takeover goes on to Singing (#167).
    await expect(
      phone.getByRole("heading", { name: "Sing it!" }),
    ).toBeVisible();
    // At each Line end the Stage's running total reaches this Phone (#167).
    await expect
      .poll(
        async () =>
          Number(await phone.getByTestId("takeover-score").textContent()),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    // The seat hears its Mic: it never goes "mic lost".
    await stage.waitForTimeout(2500);
    await expect(stage.locator("[data-lane-header][data-lost]")).toHaveCount(0);
    const response = await round;
    playing = false;
    expect(response.status()).toBe(201);
    const stored = (await response.json()) as {
      round: { ended: string };
      results: { players: { name: string; total: number }[] };
    };
    expect(stored.round.ended).toBe("played");
    const [mine] = stored.results.players;
    expect(mine?.name).toBe(profile.name);
    expect(mine?.total ?? 0).toBeGreaterThan(0);

    await expect(frame).toHaveAttribute("data-scene", "results");
    await sendFromPhone(phone, { type: "closeResults" });
  } finally {
    if (playing)
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
  }
});
