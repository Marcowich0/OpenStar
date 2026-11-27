import type { Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// A blocked Start leads to the fix (spec #241, ticket #252): a Line-up
// warning carries its fix as a button, and a press on the greyed Start
// shakes it and moves the focus to that button. A Phone sends the Request
// and the Guest over a second socket of its own page, as `line-up.spec.ts`
// does.

interface Snapshot {
  queue: { requestId: number }[];
  members: { colour: string }[];
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

test("a press on the greyed Start takes the focus to the warning's fix, which opens the seat's Mic list", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const solo = songs.find((s) => s.path === FIXTURE_SONGS.steadyTone);
  if (!solo) throw new Error("the fixture Library has no steady tone");

  // A Profile with a name no other test uses (the server is shared).
  const created = await request.post("/api/profiles", {
    data: {
      name: `Fixer ${String(Date.now() % 100000)}`,
      avatar: { kind: "builtIn", key: "star" },
      favouriteColour: "bubblegum",
    },
  });
  expect(created.ok()).toBe(true);
  const profile = (await created.json()) as { name: string };

  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: profile.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();

  let party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: solo.id,
    requestedPlayers: null,
  });
  const guestName = `Mia ${String(Date.now() % 1000)}`;
  try {
    // A Guest with no Phone sits down: "<name> has no mic", Start greyed.
    const taken = new Set(party.members.map((m) => m.colour));
    party = await sendFromPhone(phone, {
      type: "editLineUp",
      requestId: party.queue[0]?.requestId,
      edit: {
        kind: "addSeat",
        who: {
          kind: "guest",
          name: guestName,
          colour: COLOURS.find((c) => !taken.has(c)),
          avatar: { kind: "builtIn", key: "cat" },
        },
      },
    });
    const card = stage.getByRole("group", { name: guestName, exact: true });
    await expect(card.getByText(`${guestName} has no mic`)).toBeVisible();
    const start = stage.getByRole("button", { name: "Start" });
    await expect(start).toHaveAttribute("aria-disabled", "true");

    // Space presses Start: it shakes, and the focus goes to the fix.
    await stage.keyboard.press(" ");
    const fix = card.getByRole("button", { name: "Pick a mic" });
    await expect(fix).toBeFocused();
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );

    // Enter on the fix opens that seat's Mic list.
    await stage.keyboard.press("Enter");
    await expect(
      stage.getByRole("menu", { name: `Mic for ${guestName}` }),
    ).toBeVisible();
    await stage.keyboard.press("Escape");
    await expect(stage.getByRole("menu")).toHaveCount(0);
  } finally {
    for (const { requestId } of party.queue)
      await sendFromPhone(phone, { type: "removeRequest", requestId });
  }
});
