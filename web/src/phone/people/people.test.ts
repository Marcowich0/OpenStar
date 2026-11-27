import { describe, expect, it } from "vitest";

import type { PartyMember } from "../../generated/PartyMember";
import type { Profile } from "../../generated/Profile";
import type { Seat } from "../../generated/Seat";
import {
  myDifficulty,
  peopleRows,
  playingSeats,
  showsAdminLink,
} from "./people";
import type { PartySnapshot } from "../../generated/PartySnapshot";

const profile = (id: number, name: string, more: Partial<Profile> = {}) =>
  ({
    id,
    name,
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
    ...more,
  }) satisfies Profile;

const BO = profile(7, "Bo", { favouriteColour: "cherry" });
const JONAS = profile(8, "Jonas", {
  favouriteColour: "cherry",
  lastDifficulty: "hard",
});

const bo: PartyMember = {
  memberId: 1,
  identity: { kind: "profile", profileId: 7 },
  colour: "cherry",
  favouriteTaken: false,
  onPhone: true,
  singing: false,
};
const jonas: PartyMember = {
  memberId: 2,
  identity: { kind: "profile", profileId: 8 },
  colour: "sky",
  favouriteTaken: true,
  onPhone: false,
  singing: false,
};
const kim: PartyMember = {
  memberId: 3,
  identity: {
    kind: "guest",
    name: "Kim",
    avatar: { kind: "builtIn", key: "star" },
    difficulty: "easy",
  },
  colour: "lime",
  favouriteTaken: false,
  onPhone: true,
  singing: true,
};

const seat = (memberId: number, phoneId: string | null): Seat => ({
  memberId,
  mic: phoneId === null ? null : { kind: "phone", phoneId },
  voice: "p1",
  difficulty: "hard",
});

describe("the People tab's rows", () => {
  const rows = peopleRows([bo, jonas, kim], 1, [BO, JONAS]);

  it("lists every Party member in entry order, with their name", () => {
    expect(rows.map((r) => r.look?.name)).toEqual(["Bo", "Jonas", "Kim"]);
  });

  it("tags this Phone's own member as me and Guests as guest", () => {
    expect(rows.map((r) => [r.isMe, r.guest])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
  });

  it("names the favourite colour a Profile did not get", () => {
    expect(rows.map((r) => r.favouriteTaken)).toEqual([null, "cherry", null]);
  });

  it("offers the × on everyone but me and those singing", () => {
    expect(rows.map((r) => r.remove)).toEqual(["none", "hold", "singing"]);
  });
});

describe("My Difficulty for the next Song", () => {
  it("is a Profile's last Difficulty and a Guest's own", () => {
    expect(myDifficulty(jonas, [BO, JONAS], null)).toBe("hard");
    expect(myDifficulty(kim, [], null)).toBe("easy");
  });

  it("is the seat's Difficulty while the member sits in the Line-up", () => {
    expect(myDifficulty(kim, [], [seat(3, "phone-a")])).toBe("hard");
  });

  it("is unknown until the Profiles load", () => {
    expect(myDifficulty(bo, undefined, null)).toBeNull();
  });
});

describe("the Me sheet's Admin link", () => {
  it("shows while no Song plays", () => {
    expect(showsAdminLink("phone-a", null)).toBe(true);
  });

  it("shows while a Song plays without this Phone as a Mic", () => {
    expect(showsAdminLink("phone-a", [seat(1, "phone-b"), seat(2, null)])).toBe(
      true,
    );
  });

  it("hides while this Phone is the Mic of a seat in the playing Song", () => {
    expect(showsAdminLink("phone-a", [seat(2, null), seat(1, "phone-a")])).toBe(
      false,
    );
  });
});

describe("the playing Song's seats", () => {
  const lineUp = {
    requestId: 1,
    duet: false,
    seats: [seat(1, "phone-a")],
    canStart: true,
    warnings: [],
  };
  const party = (playing: boolean): PartySnapshot => ({
    partyId: "p",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members: [bo],
    phones: [],
    queue: [],
    head: 1,
    lineUp,
    playing: playing ? { requestId: 1, songId: 40, paused: false } : null,
    results: null,
    localMics: [],
  });

  it("are none while the Line-up only waits", () => {
    expect(playingSeats(party(false))).toBeNull();
  });

  it("are the Line-up's seats while its Song plays", () => {
    expect(playingSeats(party(true))).toEqual(lineUp.seats);
  });
});
