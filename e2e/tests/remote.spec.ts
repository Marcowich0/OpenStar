import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// The Remote frame (#117): the Queue tab's badge, the status strip while a
// Line-up waits, the Stage tab as the default tab then, and the toasts, in
// the second person for the Phone's own change. It sends `addRequest` over
// a second socket of the Phone itself (`songs.spec.ts` adds from the Songs
// tab).

/**
 * A Profile with a name no other test uses (the server is shared). Its
 * favourite colour is free: the test starts a New party first.
 */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<string> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "rocket" },
      favouriteColour,
    },
  });
  expect(response.ok()).toBe(true);
  return name;
}

/** A Phone joins from the QR link as the Profile `name`. */
async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

/**
 * Sends `message` from the Phone, as the Phone: a second socket in its page
 * presents its Phone id, sends the message and returns the Queue's Request
 * ids from the Party change it caused.
 */
async function sendFromPhone(phone: Page, message: object): Promise<number[]> {
  return phone.evaluate(
    (message) =>
      new Promise<number[]>((resolve, reject) => {
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
            resolve(reply.party.queue.map((r) => r.requestId));
          }
        };
      }),
    message,
  );
}

test("the Remote shows the Queue badge, the waiting Line-up and every change as a toast", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const adder = await createProfile(request, "Adder", "lime");
  const watcher = await createProfile(request, "Watcher", "berry");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string; title: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.sineMelody);
  if (!song) throw new Error("the fixture Library has no Sine Melody");

  const mine = await openPhone();
  await joinAs(mine, code, adder);
  const theirs = await openPhone();
  await joinAs(theirs, code, watcher);

  // An empty Queue: Songs, no badge, no strip.
  await expect(theirs.getByRole("tab", { name: "Songs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(theirs.getByText("Waiting for Start")).toHaveCount(0);

  const queue = await sendFromPhone(mine, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: null,
  });
  try {
    // The toast, in the second person on the Phone that made the change and
    // with the actor's name and avatar on the other.
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${song.title} added, number 1`);
    const toasts = theirs.getByRole("status", { name: "Party changes" });
    await expect(toasts).toContainText(`${adder} added ${song.title}`);
    await expect(
      toasts.getByRole("img", { name: adder, includeHidden: true }),
    ).toBeAttached();

    // The badge, and the strip off the Stage tab.
    await expect(
      theirs.getByRole("tab", { name: "Queue, 1 Request" }),
    ).toBeVisible();
    const strip = theirs.getByRole("button", {
      name: new RegExp(`Line-up for ${song.title}`),
    });
    await expect(strip).toContainText("Waiting for Start");
    await strip.click();
    await expect(theirs.getByRole("tab", { name: "Stage" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(strip).toHaveCount(0);

    // Opened while the Line-up waits, the Remote starts on the Stage tab.
    await mine.reload();
    await expect(mine.getByRole("tab", { name: "Stage" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    // Empty the Queue, so the Stage is back on the song browser.
    for (const requestId of queue)
      await sendFromPhone(mine, { type: "removeRequest", requestId });
  }
});
