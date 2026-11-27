import type { Locator, Page } from "@playwright/test";

import { expect, FIXTURE_SONGS, newParty, test } from "../fixtures";
import { createProfile, liveParty, sendFromPhone } from "../flows";

// The Join chip (#250): the Line-up and the results show "Join · 4821" in a
// corner that holds nothing else, and pressing it opens People. The Join code
// read from the chip lets a Phone join. Where it sits is checked with 4 seats
// (warnings under them) and 4 results bars, at 1280 × 800 and 1920 × 1080:
// the Stage's `/ws/stage` is answered by the test there, so the Party can
// hold 4 Players without 4 Phones singing a Song to its end.

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function chip(stage: Page): Locator {
  return stage.getByRole("button", { name: /^Join · \d{4}/ });
}

/** Resizes the Stage and waits until the reference frame has scaled. */
async function resize(
  stage: Page,
  viewport: { width: number; height: number },
) {
  await stage.setViewportSize(viewport);
  const scale = Math.min(viewport.width / 1920, viewport.height / 1080);
  await expect
    .poll(
      async () =>
        (await box(stage.locator("[data-reference-box]").first())).width,
    )
    .toBeCloseTo(1920 * scale, 0);
}

/** Every element of `things` that `chip` overlaps, by its text. */
async function underChip(chipBox: Box, things: Locator): Promise<string[]> {
  const hits: string[] = [];
  for (const thing of await things.all()) {
    if (overlaps(chipBox, await box(thing)))
      hits.push((await thing.textContent()) ?? "?");
  }
  return hits;
}

async function fixtureSongId(stage: Page): Promise<number> {
  const response = await stage.request.get("/api/songs");
  const { songs } = (await response.json()) as {
    songs: { id: number; path: string }[];
  };
  const song = songs.find((s) => s.path === FIXTURE_SONGS.steadyTone);
  if (!song) throw new Error("the fixture Library has no Steady Tone");
  return song.id;
}

test("the Join code on the Line-up's chip lets a Phone join, and the chip opens People", async ({
  stage,
  openPhone,
  request,
}) => {
  const songId = await fixtureSongId(stage);
  const code = await newParty(stage);
  const name = await createProfile(request, "Join chip", "lime");
  const phone = await openPhone();
  await phone.goto(`/?join=${code}`);
  await phone.getByRole("button", { name, exact: true }).click();
  await expect(phone.getByRole("tab", { name: "Songs" })).toBeVisible();
  await sendFromPhone(phone, {
    type: "addRequest",
    songId,
    requestedPlayers: null,
  });

  try {
    await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
      "data-scene",
      "lineUp",
    );
    await expect(chip(stage)).toBeVisible();
    const shown = chip(stage).getByTestId("party-join-code");
    await expect(shown).toHaveText(code);
    const read = (await shown.textContent()) ?? "";

    // A second Phone types the code it read on the chip.
    const second = await openPhone();
    await second.goto("/");
    await expect(
      second.getByRole("heading", { name: "Join the Party" }),
    ).toBeVisible();
    for (const digit of read)
      await second.getByRole("button", { name: digit, exact: true }).click();
    await expect(
      second.getByRole("heading", { name: "Who's singing?" }),
    ).toBeVisible();

    await chip(stage).click();
    const people = stage.getByRole("dialog", { name: "Tonight's Party" });
    await expect(people).toBeVisible();
    await expect(people.getByTestId("party-join-code")).toHaveText(code);
    await stage.keyboard.press("Escape");
    await expect(people).toHaveCount(0);
  } finally {
    for (const { requestId } of (await liveParty(phone)).queue)
      await sendFromPhone(phone, { type: "removeRequest", requestId });
  }
});

const PEOPLE = ["Ana", "Bo", "Cy", "Dee"] as const;
const COLOURS = ["cherry", "sky", "grape", "lime"] as const;

function members() {
  return PEOPLE.map((name, i) => ({
    memberId: i + 1,
    identity: {
      kind: "guest",
      name,
      avatar: { kind: "builtIn", key: "cat" },
      difficulty: "medium",
    },
    colour: COLOURS[i],
    favouriteTaken: false,
    onPhone: false,
    singing: true,
  }));
}

function party(songId: number, scene: "lineUp" | "results") {
  const request = {
    requestId: 1,
    kind: "song",
    songId,
    requestedPlayers: [],
    adder: null,
  };
  const base = {
    partyId: "join-chip",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members: members(),
    phones: [],
    localMics: [],
    playing: null,
  };
  if (scene === "lineUp")
    return {
      ...base,
      queue: [request],
      head: 1,
      lineUp: {
        requestId: 1,
        // A duet: its seat cards are the tallest (a Voice field).
        duet: true,
        seats: PEOPLE.map((_, i) => ({
          memberId: i + 1,
          mic: null,
          voice: i % 2 === 0 ? "p1" : "p2",
          difficulty: "medium",
        })),
        canStart: false,
        // A bubble under every seat, and two under the first.
        warnings: [
          { code: "notCalibrated", params: { memberId: 1 } },
          ...PEOPLE.map((_, i) => ({
            code: "noMic",
            params: { memberId: i + 1 },
          })),
        ],
      },
      results: null,
    };
  return {
    ...base,
    queue: [{ ...request, requestId: 2 }],
    head: null,
    lineUp: null,
    results: {
      requestId: 1,
      songId,
      ended: "played",
      players: PEOPLE.map((name, i) => ({
        memberId: i + 1,
        player: { kind: "guest", name },
        name,
        avatar: { kind: "builtIn", key: "cat" },
        colour: COLOURS[i],
        mic: null,
        voice: null,
        difficulty: "medium",
        total: 9000 - i * 2000,
        notes: 7000 - i * 2000,
        golden: 1000,
        lineBonus: 1000,
        place: i + 1,
        rankTitleBand: 6 - i,
        newHighScore: i === 0,
        // Every bar gets the longest note under it.
        micLost: true,
        unfinished: false,
      })),
    },
  };
}

/** Answers the Stage's `/ws/stage` with `snapshot`, as the active Stage. */
async function fakeStageSocket(stage: Page, snapshot: object) {
  await stage.routeWebSocket(/\/ws\/stage$/, (ws) => {
    ws.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { type: string };
      if (parsed.type === "hello")
        ws.send(
          JSON.stringify({
            type: "liveState",
            stageId: "main",
            party: snapshot,
            isStage: true,
          }),
        );
    });
  });
}

test("on the Line-up the chip overlaps no seat card, warning or Start", async ({
  stage,
}) => {
  await fakeStageSocket(stage, party(await fixtureSongId(stage), "lineUp"));
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "lineUp",
  );
  const seats = stage.getByRole("list", { name: "Seats" }).getByRole("group");
  await expect(seats).toHaveCount(4);
  // Each bubble is the parent of its text.
  const bubbles = stage.getByText(/has no mic$|^Not calibrated$/).locator("..");
  await expect(bubbles).toHaveCount(5);
  await expect(chip(stage)).toHaveAccessibleName(/^Join · 4821/);

  for (const viewport of VIEWPORTS) {
    await resize(stage, viewport);
    const label = `${String(viewport.width)}×${String(viewport.height)}`;
    const at = await box(chip(stage));
    expect(await underChip(at, seats), `${label}: seats`).toEqual([]);
    expect(await underChip(at, bubbles), `${label}: warnings`).toEqual([]);
    expect(
      await underChip(at, stage.getByRole("button", { name: "Start" })),
      `${label}: Start`,
    ).toEqual([]);
  }
});

test("on the results the chip overlaps no bar, its words or Next", async ({
  stage,
}) => {
  await fakeStageSocket(stage, party(await fixtureSongId(stage), "results"));
  await stage.goto("/stage");
  await expect(stage.locator("[data-stage-frame]")).toHaveAttribute(
    "data-scene",
    "results",
  );
  const bars = stage.getByTestId("results-players").getByRole("listitem");
  await expect(bars).toHaveCount(4);
  await expect(chip(stage)).toHaveAccessibleName(/^Join · 4821/);

  for (const viewport of VIEWPORTS) {
    await resize(stage, viewport);
    const label = `${String(viewport.width)}×${String(viewport.height)}`;
    const at = await box(chip(stage));
    expect(await underChip(at, bars), `${label}: bars`).toEqual([]);
    // The name, points and "mic lost" lines hang under each bar.
    expect(
      await underChip(at, bars.locator("p")),
      `${label}: under the bars`,
    ).toEqual([]);
    expect(
      await underChip(at, stage.getByRole("button", { name: /^Next/ })),
      `${label}: Next`,
    ).toEqual([]);
  }
});
