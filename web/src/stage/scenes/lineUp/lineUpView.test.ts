import { describe, expect, it } from "vitest";

import type { LineUp } from "../../../generated/LineUp";
import type { PartyMember } from "../../../generated/PartyMember";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { Request } from "../../../generated/Request";
import type { PartyLocalMic } from "../../../generated/PartyLocalMic";
import {
  localMicOptions,
  micChoices,
  micHasProblem,
  nextDifficulty,
  nextVoice,
  placeWarnings,
  pickListTop,
  profilesToEnter,
  seatLevelDbfs,
  thenSongIds,
} from "./lineUpView";

const request = (requestId: number, songId = requestId): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

const member = (memberId: number): PartyMember => ({
  memberId,
  identity: { kind: "profile", profileId: memberId },
  colour: "cherry",
  favouriteTaken: false,
  onPhone: true,
  singing: false,
});

const lineUp = (over: Partial<LineUp> = {}): LineUp => ({
  requestId: 1,
  duet: false,
  seats: [],
  canStart: false,
  warnings: [],
  ...over,
});

const party = (over: Partial<PartySnapshot> = {}): PartySnapshot => ({
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [member(1), member(2), member(3)],
  phones: [
    { phoneId: "ph-bo", memberId: 1 },
    { phoneId: "ph-mia", memberId: 2 },
  ],
  queue: [request(1, 10)],
  head: 1,
  lineUp: lineUp(),
  playing: null,
  results: null,
  localMics: [],
  ...over,
});

describe("cycling a seat's Voice and Difficulty in place", () => {
  it("swaps Voice 1 and Voice 2", () => {
    expect(nextVoice("p1")).toBe("p2");
    expect(nextVoice("p2")).toBe("p1");
  });

  it("steps Easy → Medium → Hard → Easy", () => {
    expect(nextDifficulty("easy")).toBe("medium");
    expect(nextDifficulty("medium")).toBe("hard");
    expect(nextDifficulty("hard")).toBe("easy");
  });
});

describe("the Songs after the head ('Then …')", () => {
  it("names the next two Songs of the Queue", () => {
    const queue = [request(1, 10), request(2, 20), request(3, 30), request(4)];
    expect(thenSongIds(party({ queue }))).toEqual([20, 30]);
  });

  it("names fewer when the Queue holds fewer, and none with only the head", () => {
    expect(thenSongIds(party({ queue: [request(1), request(2, 20)] }))).toEqual(
      [20],
    );
    expect(thenSongIds(party({ queue: [request(1)] }))).toEqual([]);
  });
});

describe("where each warning hangs", () => {
  const seats = [
    { memberId: 1, mic: null, voice: "p1", difficulty: "easy" },
    {
      memberId: 2,
      mic: { kind: "phone", phoneId: "ph-mia" },
      voice: "p1",
      difficulty: "easy",
    },
  ] satisfies LineUp["seats"];

  it("hangs a member's warnings under that member's seat and the Song's above Start", () => {
    const placed = placeWarnings(
      lineUp({
        duet: true,
        seats,
        warnings: [
          { code: "noMic", params: { memberId: 1 } },
          { code: "micBlocked", params: { memberId: 2 } },
          { code: "duetNeedsVoice", params: { voice: "p2" } },
        ],
      }),
    );
    expect(placed.bySeat).toEqual([
      [{ code: "noMic", params: { memberId: 1 } }],
      [{ code: "micBlocked", params: { memberId: 2 } }],
    ]);
    expect(placed.songWide).toEqual([
      { code: "duetNeedsVoice", params: { voice: "p2" } },
    ]);
  });

  it("turns the Mic field bad for no mic and for a blocked mic", () => {
    expect(micHasProblem([{ code: "noMic", params: { memberId: 1 } }])).toBe(
      true,
    );
    expect(
      micHasProblem([{ code: "micBlocked", params: { memberId: 1 } }]),
    ).toBe(true);
    expect(micHasProblem([])).toBe(false);
  });
});

describe("the Mic pick list", () => {
  const seated = lineUp({
    seats: [
      {
        memberId: 1,
        mic: { kind: "phone", phoneId: "ph-bo" },
        voice: "p1",
        difficulty: "medium",
      },
      {
        memberId: 3,
        mic: { kind: "localMic", localMicId: "lm-left" },
        voice: "p1",
        difficulty: "medium",
      },
    ],
  });
  const localMics = [
    { localMicId: "lm-left", name: "USB mic (left)", present: true },
    { localMicId: "lm-right", name: "USB mic (right)", present: false },
  ];

  it("offers every joined Phone, then the Local mics, marking the seat's own", () => {
    const choices = micChoices(party({ lineUp: seated }), seated, 0, localMics);
    expect(
      choices.map((c) => [c.label, c.current, c.usedBy, c.unavailable]),
    ).toEqual([
      [{ kind: "phone", memberId: 1 }, true, null, false],
      [{ kind: "phone", memberId: 2 }, false, null, false],
      [{ kind: "localMic", name: "USB mic (left)" }, false, 3, false],
      [{ kind: "localMic", name: "USB mic (right)" }, false, null, true],
    ]);
  });

  it("dims a Mic another seat has, naming who has it", () => {
    const choices = micChoices(party({ lineUp: seated }), seated, 1, localMics);
    expect(choices[0]).toMatchObject({ usedBy: 1, current: false });
    expect(choices[2]).toMatchObject({ usedBy: null, current: true });
  });
});

const red: PartyLocalMic = {
  localMicId: "browser:s:dongle:0",
  source: {
    kind: "browser",
    stageBrowser: "s",
    deviceId: "dongle",
    label: "USB Audio",
    channel: 0,
    stereo: true,
  },
  name: "Red mic",
  present: true,
};
const scarlett: PartyLocalMic = {
  localMicId: "bridge:b:card:1",
  source: {
    kind: "bridge",
    bridgeId: "b",
    deviceName: "card",
    label: "Scarlett",
    channel: 1,
  },
  name: "",
  present: false,
};

describe("the Local mics the Mic lists offer", () => {
  it("are the snapshot's, in its order, named (or by their default name) and dimmed when not present", () => {
    expect(localMicOptions(party({ localMics: [red, scarlett] }))).toEqual([
      { localMicId: red.localMicId, name: "Red mic", present: true },
      {
        localMicId: scarlett.localMicId,
        name: "Scarlett · Input 2",
        present: false,
      },
    ]);
  });
});

describe("a seat's meter level", () => {
  const levels = {
    browser: (deviceId: string, channel: number) =>
      deviceId === "dongle" && channel === 0 ? -20 : null,
    bridge: (localMicId: string) =>
      localMicId === scarlett.localMicId ? -30 : null,
    phone: (phoneId: string) => (phoneId === "ph-bo" ? -40 : null),
  };
  const localMics = [red, scarlett];

  it("comes from the Stage browser's meter for a Stage-browser Local mic", () => {
    expect(
      seatLevelDbfs(
        { kind: "localMic", localMicId: red.localMicId },
        localMics,
        levels,
      ),
    ).toBe(-20);
  });

  it("comes from the bridge's levels for a bridge Local mic", () => {
    expect(
      seatLevelDbfs(
        { kind: "localMic", localMicId: scarlett.localMicId },
        localMics,
        levels,
      ),
    ).toBe(-30);
  });

  it("comes from a Phone's Pitch readings for a Phone", () => {
    expect(
      seatLevelDbfs({ kind: "phone", phoneId: "ph-bo" }, localMics, levels),
    ).toBe(-40);
    expect(
      seatLevelDbfs({ kind: "phone", phoneId: "ph-mia" }, localMics, levels),
    ).toBeNull();
  });

  it("is silence with no Mic or a Local mic that is not listed", () => {
    expect(seatLevelDbfs(null, localMics, levels)).toBeNull();
    expect(
      seatLevelDbfs(
        { kind: "localMic", localMicId: "gone" },
        localMics,
        levels,
      ),
    ).toBeNull();
  });
});

describe("profilesToEnter", () => {
  const profile = (
    id: number,
    name: string,
    lastSungAt: number | null,
  ): Profile => ({
    id,
    name,
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "sky",
    lastDifficulty: "medium",
    createdAt: 1,
    lastSungAt,
  });

  it("lists Profiles not in the Party, most recently sung first, then those that never sang by name", () => {
    const profiles = [
      profile(1, "Zoe", null),
      profile(2, "Ann", 100),
      profile(3, "bea", null),
      profile(4, "Cid", 300),
      profile(5, "Dan", 200),
      profile(6, "Abe", null),
    ];
    const members = [member(5)];
    expect(profilesToEnter(members, profiles).map((p) => p.name)).toEqual([
      "Cid",
      "Ann",
      "Abe",
      "bea",
      "Zoe",
    ]);
  });

  it("is empty while the Profiles load", () => {
    expect(profilesToEnter([member(1)], undefined)).toEqual([]);
  });
});

describe("pickListTop", () => {
  // The anchor spans 300..450 in the 1080 px tall reference frame.
  const anchor = { top: 300, bottom: 450 };

  it("hangs a list that fits 16 px under its field", () => {
    expect(pickListTop(anchor, 400)).toBe(166);
  });

  it("opens a list above the field when it does not fit under it", () => {
    expect(pickListTop({ top: 700, bottom: 820 }, 500)).toBe(-516);
  });

  it("keeps a list that fits neither way 20 px inside the frame", () => {
    expect(pickListTop(anchor, 800)).toBe(1060 - 800 - 300);
    expect(pickListTop(anchor, 1200)).toBe(20 - 300);
  });
});
