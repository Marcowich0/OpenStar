import { describe, expect, it } from "vitest";

import type { LineUp } from "../../../generated/LineUp";
import type { PartyMember } from "../../../generated/PartyMember";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Request } from "../../../generated/Request";
import {
  micChoices,
  micHasProblem,
  nextDifficulty,
  nextVoice,
  placeWarnings,
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
