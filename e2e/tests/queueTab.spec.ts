import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

// The Queue tab (#149): numbered Request cards, and each card's sheet sends
// its action to the server, every Phone's Queue follows and the toasts name
// who did it. The Requests are added over a second socket of the first Phone
// (as in `remote.spec.ts`). It starts a New party first, so its Profiles'
// colours are free, and empties the Queue at the end.

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

async function joinAs(phone: Page, code: string, name: string) {
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: /^Queue/ })).toBeVisible();
}

/** Sends `message` over a second socket of the Phone; returns the Queue's ids after it. */
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

/** The Queue's ids as the server has them now. */
async function queueNow(phone: Page): Promise<number[]> {
  return phone.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: { queue: { requestId: number }[] } | null;
          };
          if (reply.type === "liveState") {
            socket.close();
            resolve((reply.party?.queue ?? []).map((r) => r.requestId));
          }
        };
      }),
  );
}

async function openQueueTab(phone: Page) {
  await phone.getByRole("tab", { name: /^Queue/ }).click();
}

/** The titles of the Queue's cards, in order. */
function cards(phone: Page): Locator {
  return phone.getByRole("list", { name: "Queue" }).getByRole("listitem");
}

async function openCard(phone: Page, title: string): Promise<Locator> {
  await cards(phone).filter({ hasText: title }).getByRole("button").click();
  const sheet = phone.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("the Queue tab reorders, changes singers and removes, and every Phone follows", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const adder = await createProfile(request, "Queuer", "sky");
  const mover = await createProfile(request, "Mover", "bubblegum");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string; title: string }[];
  };
  const byPath = (path: string) => {
    const song = songs.find((s) => s.path === path);
    if (!song) throw new Error(`the fixture Library has no ${path}`);
    return song;
  };
  const [first, second, third] = [
    byPath(FIXTURE_SONGS.steadyTone),
    byPath(FIXTURE_SONGS.sineMelody),
    byPath(FIXTURE_SONGS.duet),
  ];

  const mine = await openPhone();
  await joinAs(mine, code, adder);
  const theirs = await openPhone();
  await joinAs(theirs, code, mover);

  try {
    for (const song of [first, second, third])
      await sendFromPhone(mine, {
        type: "addRequest",
        songId: song.id,
        requestedPlayers: null,
      });

    // The adder is seated on its own Phone for the first Song: its mic
    // takeover shows (#167), with the Remote one tap away.
    await mine.getByRole("button", { name: "Queue & controls" }).click();
    await openQueueTab(mine);
    await openQueueTab(theirs);
    await expect(cards(theirs)).toHaveText([
      new RegExp(`^1.*Up next.*${first.title}.*added by ${adder}`),
      new RegExp(`^2.*${second.title}.*added by ${adder}`),
      new RegExp(`^3.*${third.title}.*added by ${adder}`),
    ]);

    // Play next from the third place.
    let sheet = await openCard(theirs, third.title);
    await expect(sheet.getByRole("button")).toHaveText([
      "Play next",
      "Move up",
      "Change singers",
      "Remove from the Queue",
    ]);
    await sheet.getByRole("button", { name: "Play next" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${mover} made ${third.title} play next`);
    await expect(cards(mine)).toHaveText([
      new RegExp(first.title),
      new RegExp(third.title),
      new RegExp(second.title),
    ]);

    // Move down from the second place.
    sheet = await openCard(theirs, third.title);
    await sheet.getByRole("button", { name: "Move down" }).click();
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${mover} moved ${third.title} down`);
    await expect(cards(mine).nth(2)).toContainText(third.title);

    // Change singers: the Request sheet's "Save singers" form.
    sheet = await openCard(theirs, second.title);
    await sheet.getByRole("button", { name: "Change singers" }).click();
    const singers = theirs.getByRole("dialog", { name: second.title });
    await singers.getByRole("button", { name: new RegExp(mover) }).click();
    await singers.getByRole("button", { name: "Save singers" }).click();
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${mover} changed who sings ${second.title}`);
    await expect(cards(mine).nth(1)).toContainText(
      new RegExp(`${adder}, ${mover} · added by ${adder}`),
    );

    // Remove from the Queue is a press and hold.
    sheet = await openCard(theirs, third.title);
    const remove = sheet.getByRole("button", { name: "Remove from the Queue" });
    await holdToConfirm(remove);
    await expect(
      mine.getByRole("status", { name: "Party changes" }),
    ).toContainText(`${mover} removed ${third.title}`);
    await expect(cards(mine)).toHaveCount(2);
    await expect(cards(theirs)).toHaveCount(2);
  } finally {
    // Empty the Queue, so the Stage is back on the song browser.
    for (const requestId of await queueNow(mine))
      await sendFromPhone(mine, { type: "removeRequest", requestId });
  }
});
