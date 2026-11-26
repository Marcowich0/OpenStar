import type { APIRequestContext, Page } from "@playwright/test";

import {
  bridgeControl,
  expect,
  FIXTURE_SONGS,
  newParty,
  test,
} from "../fixtures";

// A Local mic of a Mic bridge that closes (v1 spec #51, "Mic warnings" and
// "Unplugged, closed and back"): with no Song playing, its seat keeps it and
// shows "<host> mic bridge is closed" without blocking Start; during a Song
// it is a lost Mic (the grey lane's pill) while the Song plays on, and when
// the bridge comes back its readings reattach it to the same seat with a
// toast naming the Player. The shared `--wav` bridge (`scripts/e2e.sh`)
// hears the tone on channel 0; `bridgeControl` stops and starts it.

/** Sends `message` as the Phone over a second socket of its own page. */
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

async function songId(request: APIRequestContext, path: string) {
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === path);
  if (!song) throw new Error(`the fixture Library has no ${path}`);
  return song.id;
}

/** Opens Setup › Mics; the bridge's group, approved if it was waiting. */
async function bridgeGroup(stage: Page) {
  await stage.getByRole("button", { name: "Setup" }).click();
  await stage.getByRole("menuitem", { name: "Mics", exact: true }).click();
  const mics = stage.getByRole("dialog", { name: "Mics" });
  const waiting = mics.getByRole("group", { name: "New bridges" });
  const bridge = mics.getByTestId("mics-bridge");
  await expect(waiting.or(bridge).first()).toBeVisible({ timeout: 15_000 });
  if (await waiting.isVisible()) {
    await waiting
      .getByRole("button", { name: /^Approve mic bridge .*, code \d{4}$/ })
      .click();
  }
  await expect(bridge.getByText("Open", { exact: true })).toBeVisible();
  return bridge;
}

/** Switches the bridge's channel 0 on or off on the Mics screen, then closes it. */
async function switchChannel0(stage: Page, on: boolean) {
  const bridge = await bridgeGroup(stage);
  // Channel 0 by its name, wherever switching it puts its row.
  const input1 = bridge.getByRole("switch", {
    name: /· Input 1 switched on$/,
  });
  if ((await input1.getAttribute("aria-checked")) !== String(on))
    await input1.click();
  await expect(input1).toHaveAttribute("aria-checked", String(on));
  await stage.keyboard.press("Escape");
  await expect(stage.getByRole("dialog", { name: "Mics" })).toHaveCount(0);
}

async function mediaTime(stage: Page): Promise<number> {
  return stage.evaluate(
    () =>
      document.querySelector<HTMLMediaElement>("audio, video")?.currentTime ??
      -1,
  );
}

test("a closed Mic bridge keeps its seat, warns, and reattaches by itself mid-Song", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(90_000);
  const code = await newParty(stage);
  await switchChannel0(stage, true);
  let requestId: number | null = null;
  let phone: Page | null = null;
  let bridgeStopped = false;
  try {
    const name = `Mia ${String(Date.now() % 100000)}`;
    const made = await request.post("/api/profiles", {
      data: {
        name,
        avatar: { kind: "builtIn", key: "star" },
        favouriteColour: "berry",
      },
    });
    expect(made.ok()).toBe(true);
    phone = await openPhone();
    await phone.goto(`/?join=${code}`);
    await phone.getByRole("button", { name, exact: true }).click();
    await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
    const party = (await sendFromPhone(phone, {
      type: "addRequest",
      songId: await songId(request, FIXTURE_SONGS.steadyTone),
      requestedPlayers: null,
    })) as { queue: { requestId: number }[] };
    requestId = party.queue[0]?.requestId ?? null;

    // A free Local mic is prefilled before the Phone.
    const frame = stage.locator("[data-stage-frame]");
    await expect(frame).toHaveAttribute("data-scene", "lineUp");
    const card = stage.getByRole("group", { name });
    const mic = card.getByRole("button", { name: /Mic/ });
    await expect(mic).toContainText("multichannel.wav · Input 1");
    const start = stage.getByRole("button", { name: "Start" });

    // The bridge closes: the seat keeps its Local mic and warns; Start stays.
    await bridgeControl("stop");
    bridgeStopped = true;
    const warning = stage.getByText(/ mic bridge is closed$/);
    await expect(warning).toBeVisible({ timeout: 10_000 });
    await expect(mic).toContainText("multichannel.wav · Input 1");
    await expect(start).not.toHaveAttribute("aria-disabled", "true");

    // Back: the warning goes by itself.
    await bridgeControl("start");
    bridgeStopped = false;
    await expect(warning).toHaveCount(0, { timeout: 15_000 });

    // Sing: the bridge's readings keep the lane present.
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");
    const lost = stage.locator("[data-lane-lost]");
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(2);
    await expect(lost).toBeHidden();

    // Closed mid-Song: lost at once, and the Song plays on.
    await bridgeControl("stop");
    bridgeStopped = true;
    await expect(lost).toBeVisible({ timeout: 5_000 });
    const whenLost = await mediaTime(stage);
    await expect.poll(() => mediaTime(stage)).toBeGreaterThan(whenLost + 1);
    await expect(frame).toHaveAttribute("data-scene", "sing");

    // Back: its readings reattach it to the same seat, with a toast.
    await bridgeControl("start");
    bridgeStopped = false;
    await expect(lost).toBeHidden({ timeout: 15_000 });
    await expect(
      stage
        .getByRole("status", { name: "Party changes" })
        .getByText(`${name} is back on the mic`),
    ).toBeVisible();
  } finally {
    if (bridgeStopped) await bridgeControl("start");
    if (phone && requestId !== null)
      await sendFromPhone(phone, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => undefined);
    // Leave nothing switched on for the specs after this one.
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      /songBrowser|lineUp|results/,
    );
    await switchChannel0(stage, false);
  }
});
