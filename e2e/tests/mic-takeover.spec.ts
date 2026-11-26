import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { writeSungWav } from "../wav";

// The mic takeover when a Phone's mic fails (#176): mic blocked (a
// full-screen card with the reason and Try again, and "<name>'s mic is
// blocked" on the Stage and the Remotes), mic lost after the page was
// hidden ("Your mic stopped", Sing again on the same seat), and a Phone back
// after the Song (its own result until Done, then the Remote's Stage tab).

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

async function createProfile(
  request: APIRequestContext,
  favouriteColour: string,
) {
  const name = `Takeover ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "star" },
      favouriteColour,
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

/** Joins as `name` and asks for the Steady Tone Song: the Phone is seated. */
async function joinAndRequest(
  phone: Page,
  request: APIRequestContext,
  code: string,
  name: string,
): Promise<number> {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  const party = (await sendFromPhone(phone, {
    type: "addRequest",
    songId: await songId(request, FIXTURE_SONGS.steadyTone),
    requestedPlayers: null,
  })) as { queue: { requestId: number }[] };
  return party.queue[0]?.requestId ?? -1;
}

/** Makes the page hidden or visible, as a lock or a tab switch does. */
async function setPageHidden(phone: Page, hidden: boolean) {
  await phone.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a blocked mic shows a full-screen card with the reason; the seat warns everywhere until Try again opens it", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const profile = await createProfile(request, "teal");
  const phone = await openPhone();
  // The browser refuses the mic until the test allows it.
  await phone.addInitScript(() => {
    const flags = window as unknown as { refuseMic: boolean };
    flags.refuseMic = true;
    const devices = navigator.mediaDevices;
    const real = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints) =>
      flags.refuseMic
        ? Promise.reject(new DOMException("refused", "NotAllowedError"))
        : real(constraints);
  });
  await joinAndRequest(phone, request, code, profile.name);
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");

  await phone.getByRole("button", { name: "Turn on my mic" }).click();
  const card = phone.getByRole("region", { name: "Your mic is blocked" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Permission refused")).toBeVisible();

  const warning = `${profile.name}'s mic is blocked`;
  await expect(stage.getByText(warning)).toBeVisible();
  // Every Remote: here this Phone's own, under Queue & controls.
  await phone.getByRole("button", { name: "Queue & controls" }).click();
  await phone.getByRole("tab", { name: "Stage" }).click();
  await expect(phone.getByText(warning)).toBeVisible();
  await phone.getByRole("button", { name: "Back to my mic" }).click();

  await phone.evaluate(() => {
    (window as unknown as { refuseMic: boolean }).refuseMic = false;
  });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(phone.getByText("Mic is on")).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(stage.getByText(warning)).toHaveCount(0);
});

test("a mic lost during the Song comes back with Sing again on the same seat, and a Phone back after the Song shows its own result until Done", async ({
  stage,
  openPhone,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const code = await newParty(stage);
  const profile = await createProfile(request, "lime");
  const wav = await writeSungWav(testInfo.outputPath("sung-440.wav"), 440, 6);
  const phone = await openPhone({ wav });
  // Counts the screen Wake Lock requests.
  await phone.addInitScript(() => {
    const counter = window as unknown as { wakeLocks: number };
    counter.wakeLocks = 0;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: () => {
          counter.wakeLocks += 1;
          return Promise.resolve({ release: () => Promise.resolve() });
        },
      },
    });
  });
  const wakeLocks = () =>
    phone.evaluate(
      () => (window as unknown as { wakeLocks: number }).wakeLocks,
    );
  const requestId = await joinAndRequest(phone, request, code, profile.name);
  const frame = stage.locator("[data-stage-frame]");
  await expect(frame).toHaveAttribute("data-scene", "lineUp");

  let playing = false;
  try {
    await phone.getByRole("button", { name: "Turn on my mic" }).click();
    await expect(phone.getByText("Mic is on")).toBeVisible();
    const rate = phone.locator("[data-readings-per-second]");
    await expect
      .poll(
        async () => Number(await rate.getAttribute("data-readings-per-second")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(60);
    const round = stage.waitForResponse(
      (r) => r.url().endsWith("/api/rounds") && r.request().method() === "POST",
      { timeout: 40_000 },
    );
    await stage.keyboard.press(" ");
    playing = true;
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await expect(
      phone.getByRole("heading", { name: "Sing it!" }),
    ).toBeVisible();

    // The Phone locks; the Song keeps playing.
    await setPageHidden(phone, true);
    await setPageHidden(phone, false);
    await expect(
      phone.getByRole("heading", { name: "Your mic stopped" }),
    ).toBeVisible();
    await expect(phone.getByText(/The song kept going/)).toBeVisible();
    await expect(frame).toHaveAttribute("data-scene", "sing");

    const locksBefore = await wakeLocks();
    await phone.getByRole("button", { name: "Sing again" }).click();
    await expect(
      phone.getByRole("heading", { name: "Sing it!" }),
    ).toBeVisible();
    expect(await wakeLocks()).toBeGreaterThan(locksBefore);
    // The same Player in the same seat: the takeover is still theirs and
    // the Stage scores their lane at the next Line end.
    await expect(phone.getByText(`Mic · ${profile.name}`)).toBeVisible();
    await expect
      .poll(
        async () =>
          Number(await phone.getByTestId("takeover-score").textContent()),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // Locked again until the Song is over: back on the results, the Phone
    // shows its own result.
    await setPageHidden(phone, true);
    const response = await round;
    playing = false;
    expect(response.status()).toBe(201);
    const stored = (await response.json()) as {
      results: { players: { name: string; total: number }[] };
    };
    const [mine] = stored.results.players;
    expect(mine?.name).toBe(profile.name);
    await expect(frame).toHaveAttribute("data-scene", "results");
    await setPageHidden(phone, false);

    const after = phone.getByRole("main", { name: "After the Song" });
    await expect(after).toBeVisible();
    await expect(after.getByTestId("after-score")).toHaveText(
      String(mine?.total ?? -1),
    );
    await after.getByRole("button", { name: "Done" }).click();
    await expect(
      phone.getByRole("tab", { name: "Stage", selected: true }),
    ).toBeVisible();
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
