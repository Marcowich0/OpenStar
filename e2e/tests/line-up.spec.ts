import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// The Stage's Line-up screen (#124): a Request reaching the head of the Queue
// shows its Line-up, one card per seat, and the Stage's keyboard edits it.
// No screen adds Requests yet, so a Phone sends `addRequest` over a second
// socket of its own page, as `remote.spec.ts` does.

interface Snapshot {
  queue: { requestId: number }[];
  members: {
    memberId: number;
    colour: string;
    identity: { name?: string };
  }[];
}

/** The Party colours, in palette order. */
const COLOURS = [
  "cherry",
  "sky",
  "navy",
  "cocoa",
  "teal",
  "lime",
  "berry",
  "mint",
  "bubblegum",
  "forest",
  "grape",
  "tangerine",
];

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

/** A Profile with a name no other test uses (the server is shared). */
async function createProfile(
  request: APIRequestContext,
): Promise<{ id: number; name: string }> {
  const name = `Singer ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: {
      name,
      avatar: { kind: "builtIn", key: "star" },
      favouriteColour: "bubblegum",
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number; name: string };
}

test("a Request at the head shows its Line-up, edited from the Stage's keyboard", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const profile = await createProfile(request);
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string; title: string }[];
  };
  const byPath = (path: string) => {
    const song = songs.find((s) => s.path === path);
    if (!song) throw new Error(`the fixture Library has no ${path}`);
    return song;
  };
  const duet = byPath(FIXTURE_SONGS.duet);
  const next = [
    byPath(FIXTURE_SONGS.sineMelody),
    byPath(FIXTURE_SONGS.steadyTone),
  ];

  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: profile.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();

  let party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: duet.id,
    requestedPlayers: null,
  });
  for (const song of next)
    party = await sendFromPhone(phone, {
      type: "addRequest",
      songId: song.id,
      requestedPlayers: null,
    });
  const guestName = `Jonas ${String(Date.now() % 1000)}`;
  try {
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
    await expect(
      stage.getByRole("heading", { level: 1, name: duet.title }),
    ).toBeVisible();
    await expect(stage.getByText(/· duet$/)).toBeVisible();
    await expect(
      stage.getByText(`Then ${next[0]?.title ?? ""}, ${next[1]?.title ?? ""}`),
    ).toBeVisible();
    // No QR code or Join code on the Line-up.
    await expect(stage.getByText(code, { exact: true })).toHaveCount(0);

    // Seat the Phone's Profile from the Stage: Add a singer, then pick it.
    await stage.getByRole("button", { name: /Add a singer/ }).focus();
    await stage.keyboard.press("Enter");
    await stage
      .getByRole("menu", { name: "Who sings" })
      .getByRole("menuitem", { name: profile.name })
      .click();
    const card = stage.getByRole("group", { name: profile.name });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /Mic/ })).toContainText(
      `${profile.name}'s Phone`,
    );
    await expect(card.getByRole("meter")).toBeVisible();

    // Enter cycles Difficulty in place.
    const difficulty = card.getByRole("button", { name: /Difficulty/ });
    const was = (await difficulty.textContent()) ?? "";
    await difficulty.focus();
    await stage.keyboard.press("Enter");
    await expect(difficulty).not.toHaveText(was);

    // A Guest with no Phone, added from a Remote, shows live with its warning.
    const taken = new Set(party.members.map((m) => m.colour));
    const colour = COLOURS.find((c) => !taken.has(c));
    party = await sendFromPhone(phone, {
      type: "editLineUp",
      requestId: party.queue[0]?.requestId,
      edit: {
        kind: "addSeat",
        who: {
          kind: "guest",
          name: guestName,
          colour,
          avatar: { kind: "builtIn", key: "cat" },
        },
      },
    });
    await expect(stage.getByText(`${guestName} has no mic`)).toBeVisible();
    const start = stage.getByRole("button", { name: "Start" });
    await expect(start).toHaveAttribute("aria-disabled", "true");

    // Space on an invalid Line-up starts nothing.
    await stage.keyboard.press(" ");
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
  } finally {
    for (const { requestId } of party.queue)
      await sendFromPhone(phone, { type: "removeRequest", requestId });
    const guest = party.members.find((m) => m.identity.name === guestName);
    if (guest)
      await sendFromPhone(phone, {
        type: "removeMember",
        memberId: guest.memberId,
      });
  }
});
