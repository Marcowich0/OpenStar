import { describe, expect, it } from "vitest";

import type { LineUp } from "../../generated/LineUp";
import type { PartyLocalMic } from "../../generated/PartyLocalMic";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import { micName, seatMicOptions } from "./seatMics";

const member = (memberId: number): PartySnapshot["members"][number] => ({
  memberId,
  identity: {
    kind: "guest",
    name: `M${String(memberId)}`,
    avatar: { kind: "builtIn", key: "cat" },
    difficulty: "medium",
  },
  colour: "cherry",
  favouriteTaken: false,
  onPhone: true,
  singing: false,
});

const localMic = (
  localMicId: string,
  name: string,
  present: boolean,
): PartyLocalMic => ({
  localMicId,
  name,
  present,
  source: {
    kind: "browser",
    stageBrowser: "s",
    deviceId: "d",
    label: "USB Audio",
    channel: 0,
    stereo: true,
  },
});

const lineUp: LineUp = {
  requestId: 1,
  duet: false,
  canStart: false,
  warnings: [],
  seats: [
    {
      memberId: 1,
      mic: { kind: "phone", phoneId: "bo-phone" },
      voice: "p1",
      difficulty: "medium",
    },
    {
      memberId: 2,
      mic: { kind: "localMic", localMicId: "red" },
      voice: "p1",
      difficulty: "easy",
    },
    { memberId: 3, mic: null, voice: "p1", difficulty: "hard" },
  ],
};

const party = {
  members: [member(1), member(2), member(3)],
  phones: [
    { phoneId: "bo-phone", memberId: 1 },
    { phoneId: "jonas-phone", memberId: 2 },
  ],
};

const nameOf = (id: number) => ({ 1: "Bo", 2: "Jonas", 3: "Sara" })[id] ?? "?";

// The Party snapshot's switched-on Local mics: "unplugged" is not present.
const LOCAL_MICS = [
  localMic("red", "Red mic", true),
  localMic("unplugged", "Drawer mic", false),
  localMic("blank", "", true),
];

describe("a seat's Mic list", () => {
  it("offers every joined Phone, then the snapshot's Local mics by name", () => {
    const options = seatMicOptions({
      party,
      lineUp,
      seat: 2,
      myPhoneId: "jonas-phone",
      localMics: LOCAL_MICS,
      nameOf,
    });
    expect(options.map((o) => o.name)).toEqual([
      "Bo's phone",
      "This phone",
      "Red mic",
      "Drawer mic",
      "USB Audio · Left",
    ]);
  });

  it("marks Mics another seat uses as in use, and the seat's own as its Mic", () => {
    const options = seatMicOptions({
      party,
      lineUp,
      seat: 0,
      myPhoneId: "jonas-phone",
      localMics: LOCAL_MICS,
      nameOf,
    });
    expect(options.map((o) => [o.name, o.inUse, o.current])).toEqual([
      ["Bo's phone", false, true],
      ["This phone", false, false],
      ["Red mic", true, false],
      ["Drawer mic", false, false],
      ["USB Audio · Left", false, false],
    ]);
  });

  it("dims a Local mic that is unplugged or on a closed bridge", () => {
    const options = seatMicOptions({
      party,
      lineUp,
      seat: 0,
      myPhoneId: "jonas-phone",
      localMics: LOCAL_MICS,
      nameOf,
    });
    expect(options.map((o) => [o.name, o.unavailable])).toEqual([
      ["Bo's phone", false],
      ["This phone", false],
      ["Red mic", false],
      ["Drawer mic", true],
      ["USB Audio · Left", false],
    ]);
  });
});

describe("a seat's Mic name", () => {
  it("names Phones from this Phone's point of view and Local mics by name", () => {
    const context = {
      party,
      myPhoneId: "bo-phone",
      localMics: LOCAL_MICS,
      nameOf,
    };
    expect(micName({ kind: "phone", phoneId: "bo-phone" }, context)).toBe(
      "This phone",
    );
    expect(micName({ kind: "phone", phoneId: "jonas-phone" }, context)).toBe(
      "Jonas's phone",
    );
    expect(micName({ kind: "localMic", localMicId: "red" }, context)).toBe(
      "Red mic",
    );
  });
});
