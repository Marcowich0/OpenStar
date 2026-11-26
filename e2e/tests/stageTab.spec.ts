import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { holdToConfirm } from "../flows";

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

    // Add a singer seats the first free member, this Phone's own, and the
    // Mic prefill gives it this Phone. Seated on this Phone, it is a Mic: the
    // mic takeover replaces the Remote (#167), which opens again on top with
    // Queue & controls, and the seat's sheet opens from its row.
    await mine.getByRole("button", { name: "Add a singer" }).click();
    await expect(
      mine.getByRole("heading", { name: `You're up, ${singer}!` }),
    ).toBeVisible();
    await mine.getByRole("button", { name: "Queue & controls" }).click();
    await expect(
      mine.getByRole("button", { name: "Back to my mic" }),
    ).toBeVisible();
    await mine.getByRole("button", { name: new RegExp(`^${singer}`) }).click();
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

test("every Phone's Stage tab follows the playing Song, its results and the empty Queue, and steps the volume", async ({
  stage,
  openPhone,
  request,
}) => {
  test.setTimeout(90_000);
  const code = await newParty(stage);
  const singer = await createProfile(request, "Singer", "cocoa");
  const friend = await createProfile(request, "Friend", "forest");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string; title: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.steadyTone);
  if (!song) throw new Error("the fixture Library has no Steady Tone");

  const mine = await openPhone();
  await joinAs(mine, code, singer);
  const theirs = await openPhone();
  await joinAs(theirs, code, friend);
  const phones = [mine, theirs];

  // This Phone asks to sing it, so its member is prefilled on its own Mic.
  const { queue } = await sendFromPhone(mine, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: null,
  });
  const requestId = queue.at(-1)?.requestId;
  if (requestId === undefined) throw new Error("the Request was not added");
  const frame = stage.locator("[data-stage-frame]");
  let state: "playing" | "results" | "done" = "playing";
  try {
    await expect(frame).toHaveAttribute("data-scene", "lineUp");
    await expect(
      stage.getByRole("button", { name: "Start" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await stage.keyboard.press(" ");
    await expect(frame).toHaveAttribute("data-scene", "sing");

    // The singer's Phone is singing in its mic takeover (#167); its Remote
    // opens on top.
    await expect(mine.getByRole("heading", { name: "Sing it!" })).toBeVisible();
    await mine.getByRole("button", { name: "Queue & controls" }).click();

    // Both Stage tabs show the playing Song, its Player and its progress.
    for (const phone of phones) {
      await phone.getByRole("tab", { name: "Stage" }).click();
      const card = phone.getByTestId("playing-card");
      await expect(card).toContainText("Playing now");
      await expect(card).toContainText(song.title);
      await expect(card).toContainText(singer);
      await expect(
        phone.getByText("Hold Restart, Skip or End for a moment"),
      ).toBeVisible();
      await expect
        .poll(async () =>
          Number(
            await card.getByRole("progressbar").getAttribute("aria-valuenow"),
          ),
        )
        .toBeGreaterThan(0);
    }

    // The strip on another tab pauses the Stage; both Stage tabs say so.
    await theirs.getByRole("tab", { name: "Songs" }).click();
    await theirs.getByRole("button", { name: "Pause" }).click();
    await expect(theirs.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(mine.getByTestId("playing-card")).toContainText("Paused");
    await theirs.getByRole("button", { name: "Resume" }).click();
    await expect(mine.getByTestId("playing-card")).toContainText("Playing now");

    // The volume: one Phone steps it, the other Phone and the Stage follow.
    await theirs.getByRole("tab", { name: "Stage" }).click();
    const volumeOf = async (phone: Page) =>
      Number(
        await phone
          .getByRole("group", { name: "Volume" })
          .getByText(/^\d+$/)
          .textContent(),
      );
    await expect.poll(() => volumeOf(mine)).toBeGreaterThanOrEqual(0);
    const before = await volumeOf(mine);
    const direction = before >= 100 ? "Volume down" : "Volume up";
    const after = before >= 100 ? before - 5 : before + 5;
    await theirs
      .getByRole("group", { name: "Volume" })
      .getByRole("button", { name: direction })
      .click();
    for (const phone of phones)
      await expect.poll(() => volumeOf(phone)).toBe(after);
    await expect(stage.getByTestId("volume-pill")).toHaveText(
      `Volume ${String(after)}`,
    );

    // End is a hold: a tap alone leaves the Song playing.
    const end = mine.getByRole("button", { name: "End" });
    await end.click();
    await expect(mine.getByText("Hold for a moment")).toBeVisible();
    await expect(frame).toHaveAttribute("data-scene", "sing");
    await holdToConfirm(end, { with: "pointer" });
    state = "results";

    // Both Stage tabs show the results; the Queue is empty, so Done.
    await expect(frame).toHaveAttribute("data-scene", "results");
    // The singer's Phone shows its own result first (#176); Done opens
    // its Remote's Stage tab.
    await mine
      .getByRole("main", { name: "After the Song" })
      .getByRole("button", { name: "Done" })
      .click();
    await expect(
      mine.getByRole("tab", { name: "Stage", selected: true }),
    ).toBeVisible();
    for (const phone of phones) {
      const card = phone.getByTestId("results-card");
      await expect(card).toContainText("Results on the Stage");
      await expect(card).toContainText(song.title);
      await expect(card.getByRole("button", { name: "Done" })).toBeVisible();
    }
    await theirs.getByRole("button", { name: "Done" }).click();
    state = "done";
    await expect(frame).toHaveAttribute("data-scene", "songBrowser");
    for (const phone of phones) {
      await expect(phone.getByText("The Stage is waiting")).toBeVisible();
      await expect(
        phone.getByText("The Queue is empty. Pick a song."),
      ).toBeVisible();
      await expect(phone.getByRole("group", { name: "Volume" })).toBeVisible();
    }
  } finally {
    if (state === "playing")
      await sendFromPhone(theirs, {
        type: "controlSong",
        requestId,
        control: "skip",
      }).catch(() => null);
    if (state === "results")
      await sendFromPhone(theirs, { type: "closeResults" }).catch(() => null);
  }
});
