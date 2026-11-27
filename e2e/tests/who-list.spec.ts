import type { APIRequestContext, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";

// The Line-up's Who list (#125): after the Party members it lists the
// Profiles not in the Party yet, then + Guest and + Profile, so the host
// seats people from the Stage alone. No Stage screen adds Requests yet, so a
// Phone queues the Song over a second socket of its own page, as
// `line-up.spec.ts` does.

interface Snapshot {
  queue: { requestId: number }[];
  members: {
    memberId: number;
    identity: { kind: string; name?: string; profileId?: number };
  }[];
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

/** A Profile with a name no other test uses (the server is shared). */
async function createProfile(
  request: APIRequestContext,
  prefix: string,
  favouriteColour: string,
): Promise<{ id: number; name: string }> {
  const name = `${prefix} ${String(Date.now() % 100000)}`;
  const response = await request.post("/api/profiles", {
    data: { name, avatar: { kind: "builtIn", key: "star" }, favouriteColour },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: number; name: string };
}

test("the Stage seats a Profile not in the Party and a new Guest from its keyboard", async ({
  stage,
  openPhone,
  request,
}) => {
  const code = await newParty(stage);
  const host = await createProfile(request, "Host", "bubblegum");
  const regular = await createProfile(request, "Regular", "teal");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.sineMelody);
  if (!song) throw new Error("the fixture Library has no sine melody");

  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: host.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  let party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: null,
  });
  const guestName = `Noor ${String(Date.now() % 1000)}`;
  try {
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
    const whoList = stage.getByRole("menu", { name: "Who sings" });
    const addSinger = stage.getByRole("button", { name: /Add a singer/ });

    // The Profile not in the Party follows the members; + Guest and
    // + Profile end the list. Picking it seats it and enters it.
    await addSinger.focus();
    await stage.keyboard.press("Enter");
    const entries = whoList.getByRole("menuitem");
    await expect(entries.first()).toHaveText(host.name);
    await expect(entries.nth(-2)).toHaveText("+ Guest");
    await expect(entries.nth(-1)).toHaveText("+ Profile");
    await whoList.getByRole("menuitem", { name: regular.name }).click();
    await expect(
      stage.getByRole("group", { name: regular.name }),
    ).toBeVisible();

    // + Guest: type the name, step the colour and the avatar, OK.
    await addSinger.focus();
    await stage.keyboard.press("Enter");
    // From the keyboard: under a mouse pointer, hover moves the focus.
    await stage.mouse.move(0, 0);
    await whoList.getByRole("menuitem", { name: "+ Guest" }).focus();
    await stage.keyboard.press("Enter");
    const name = whoList.getByRole("textbox", { name: "Name" });
    await expect(name).toBeFocused();
    await stage.keyboard.type(guestName);
    await stage.keyboard.press("ArrowDown");
    const colours = whoList.getByRole("radiogroup", { name: "Colour" });
    await expect(colours).toBeFocused();
    // The members hold Bubblegum and Teal: Cherry is the first free colour,
    // Sky the next.
    await expect(
      colours.getByRole("radio", { checked: true }),
    ).toHaveAccessibleName("Cherry");
    await stage.keyboard.press("ArrowRight");
    await expect(
      colours.getByRole("radio", { checked: true }),
    ).toHaveAccessibleName("Sky");
    await stage.keyboard.press("ArrowDown");
    await stage.keyboard.press("ArrowRight");
    await stage.keyboard.press("ArrowDown");
    await expect(whoList.getByRole("button", { name: "OK" })).toBeFocused();
    await stage.keyboard.press("Enter");

    const card = stage.getByRole("group", { name: guestName });
    await expect(card).toBeVisible();
    await expect(whoList).toHaveCount(0);
    await expect(stage.getByText(`${guestName} has no mic`)).toBeVisible();
  } finally {
    // Take the Request off, then the members this test entered.
    for (const { requestId } of party.queue)
      party = await sendFromPhone(phone, { type: "removeRequest", requestId });
    for (const member of party.members) {
      const isGuest = member.identity.name === guestName;
      const isRegular = member.identity.profileId === regular.id;
      if (isGuest || isRegular)
        await sendFromPhone(phone, {
          type: "removeMember",
          memberId: member.memberId,
        });
    }
  }
});

test("the Stage's + Guest form fits at 1280×800 with big tinted pictures, and Cancel and Esc close it", async ({
  stage,
  openPhone,
  request,
}) => {
  await stage.setViewportSize({ width: 1280, height: 800 });
  const code = await newParty(stage);
  const host = await createProfile(request, "Host", "bubblegum");
  const { songs } = (await (await request.get("/api/songs")).json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.sineMelody);
  if (!song) throw new Error("the fixture Library has no sine melody");

  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name: host.name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  let party = await sendFromPhone(phone, {
    type: "addRequest",
    songId: song.id,
    requestedPlayers: null,
  });
  const membersBefore = party.members.length;
  try {
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
    const whoList = stage.getByRole("menu", { name: "Who sings" });
    const addSinger = stage.getByRole("button", { name: /Add a singer/ });
    const openGuestForm = async () => {
      await addSinger.focus();
      await stage.keyboard.press("Enter");
      await stage.mouse.move(0, 0);
      await whoList.getByRole("menuitem", { name: "+ Guest" }).focus();
      await stage.keyboard.press("Enter");
      await expect(
        whoList.getByRole("textbox", { name: "Name" }),
      ).toBeFocused();
      await whoList.evaluate((element) =>
        Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        ),
      );
    };

    await openGuestForm();
    // The whole form shows in the window, and the page does not scroll.
    const form = await whoList.boundingBox();
    expect(form).not.toBeNull();
    if (!form) return;
    expect(form.x).toBeGreaterThanOrEqual(0);
    expect(form.y).toBeGreaterThanOrEqual(0);
    expect(form.x + form.width).toBeLessThanOrEqual(1280);
    expect(form.y + form.height).toBeLessThanOrEqual(800);
    expect(
      await stage.evaluate(
        () =>
          document.documentElement.scrollHeight <= window.innerHeight &&
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // Each picture is at least 48 px, in the chosen colour, and recoloured
    // when the colour changes.
    const pictures = whoList.getByRole("radiogroup", { name: "Picture" });
    const fills = () =>
      pictures.evaluate((group) => [
        ...new Set(
          [...group.querySelectorAll("circle")].map(
            (circle) => getComputedStyle(circle).fill,
          ),
        ),
      ]);
    for (const box of await Promise.all(
      (await pictures.locator("[role=img]").all()).map((img) =>
        img.boundingBox(),
      ),
    )) {
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    }
    const before = await fills();
    expect(before).toHaveLength(1);
    await stage.keyboard.press("ArrowDown");
    await stage.keyboard.press("ArrowRight");
    const after = await fills();
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);

    // Esc closes it without adding anyone, back on Add a singer.
    await stage.keyboard.press("Escape");
    await expect(whoList).toHaveCount(0);
    await expect(addSinger).toBeFocused();

    // So does Cancel.
    await openGuestForm();
    await stage.keyboard.type("Nobody");
    await whoList.getByRole("button", { name: "Cancel" }).click();
    await expect(whoList).toHaveCount(0);
    await expect(addSinger).toBeFocused();
  } finally {
    for (const { requestId } of party.queue)
      party = await sendFromPhone(phone, { type: "removeRequest", requestId });
  }
  expect(party.members).toHaveLength(membersBefore);
});
