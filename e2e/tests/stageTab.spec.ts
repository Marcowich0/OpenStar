import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// The Phone's Stage tab (#118): the waiting Line-up edited from the sofa
// through the seat sheet, seen on a second Phone, and Start. The Request is
// added over a second socket of the Phone itself, like `remote.spec.ts`.
// It starts a New party first, so its Profiles' colours are free.

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
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
}

interface PartyReply {
  queue: { requestId: number }[];
  playing: { requestId: number } | null;
}

/** Sends `message` as the Phone over a second socket; the Party it caused. */
async function sendFromPhone(
  phone: Page,
  message: object,
): Promise<PartyReply> {
  return phone.evaluate(
    (message) =>
      new Promise<PartyReply>((resolve, reject) => {
        const phoneId = localStorage.getItem("openstar.phoneId");
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "hello", phoneId }));
        };
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data)) as {
            type: string;
            party?: PartyReply;
          };
          if (reply.type === "phoneStatus")
            socket.send(JSON.stringify(message));
          if (reply.type === "rejected") {
            socket.close();
            reject(new Error(String(event.data)));
          }
          if (reply.type === "partyChanged" && reply.party) {
            socket.close();
            resolve(reply.party);
          }
        };
      }),
    message,
  );
}

test("a Phone seats itself on its own Mic from the Stage tab and presses Start", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const singer = await createProfile(request, "Singer", "cocoa");
  const friend = await createProfile(request, "Friend", "forest");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string; title: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.sineMelody);
  if (!song) throw new Error("the fixture Library has no Sine Melody");

  const mine = await openPhone();
  // A breathing Start never holds still, and Playwright clicks only a still
  // button; reduced motion stops the breathing.
  await mine.emulateMedia({ reducedMotion: "reduce" });
  await joinAs(mine, code, singer);
  const theirs = await openPhone();
  await joinAs(theirs, code, friend);

  // Nobody asked to sing it, so the Line-up waits empty.
  const { queue } = await sendFromPhone(mine, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: [],
  });
  const requestId = queue.at(-1)?.requestId;
  if (requestId === undefined) throw new Error("the Request was not added");
  try {
    await mine.getByRole("tab", { name: "Stage" }).click();
    await expect(mine.getByText("Up next: who sings?")).toBeVisible();
    await expect(mine.getByRole("heading", { name: song.title })).toBeVisible();
    const start = mine.getByRole("button", { name: "Start" });
    await expect(start).toHaveAttribute("aria-disabled", "true");

    // Add a singer opens the new seat's sheet; Who puts this Phone's member
    // in it, and the Mic prefill gives it this Phone.
    await mine.getByRole("button", { name: "Add a singer" }).click();
    const who = mine.getByRole("group", { name: "Who" });
    await who.getByRole("button", { name: singer, exact: true }).click();
    const sheet = mine.getByRole("dialog", { name: singer });
    const mic = sheet.getByRole("group", { name: "Mic" });
    await expect(
      mic.getByRole("button", { name: "This phone" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      mic.getByRole("button", { name: `${friend}'s phone` }),
    ).toBeEnabled();
    await sheet
      .getByRole("group", { name: "Difficulty" })
      .getByRole("button", { name: "Hard" })
      .click();
    await expect(
      sheet
        .getByRole("group", { name: "Difficulty" })
        .getByRole("button", { name: "Hard" }),
    ).toHaveAttribute("aria-pressed", "true");
    await mine.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // Both Remotes show the seat, each naming the Phone from its own side.
    await expect(
      mine.getByRole("button", { name: new RegExp(`^${singer}`) }),
    ).toContainText("This phone · Hard");
    await theirs.getByRole("tab", { name: "Stage" }).click();
    await expect(
      theirs.getByRole("button", { name: new RegExp(`^${singer}`) }),
    ).toContainText(`${singer}'s phone · Hard`);

    // Valid now: Start starts the Song on the Stage.
    await expect(start).toHaveAttribute("aria-disabled", "false");
    await start.click();
    await expect(theirs.getByText("Up next: who sings?")).toHaveCount(0);
  } finally {
    // Stop the Song and empty the Queue: the next test's New party needs the
    // Stage on a scene that opens People.
    const party = await sendFromPhone(theirs, {
      type: "controlSong",
      requestId,
      control: "skip",
    }).catch(() => null);
    if (party === null)
      await sendFromPhone(theirs, { type: "removeRequest", requestId });
  }
});
