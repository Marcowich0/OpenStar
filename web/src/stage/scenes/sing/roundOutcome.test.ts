import { describe, expect, it } from "vitest";

import type { PlayerOutcome } from "../../../scoring/liveScoring";
import { roundOutcome } from "./roundOutcome";
import {
  LEO,
  LEO_SEAT,
  MIA,
  MIA_SEAT,
  testParty,
  testLineUp,
} from "./testSong";

function played(over: Partial<PlayerOutcome> = {}): PlayerOutcome {
  return {
    voice: 0,
    difficulty: "hard",
    micKind: "phone",
    beatRange: { firstBeat: 0, lastBeat: 1 },
    beatValues: [{ kind: "pitch", pitch: 60 }, { kind: "noVoice" }],
    sums: { notes: 4500, golden: 0, lineBonus: 500.4 },
    score: { total: 5000, notes: 4500, golden: 0, lineBonus: 500 },
    finished: true,
    micLost: false,
    lineResults: [],
    ...over,
  };
}

describe("the round's outcome the Stage sends", () => {
  it("names each seat's Profile or Guest and carries its Score, in seat order", () => {
    const party = testParty({
      members: [MIA, LEO],
      lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true),
    });
    const outcome = roundOutcome({
      requestId: 5,
      songId: 7,
      party,
      memberIds: [MIA.memberId, LEO.memberId],
      scoring: {
        noteFingerprint: "f1ng3rpr1nt",
        players: [
          played(),
          played({
            voice: 1,
            difficulty: "easy",
            micKind: "localMic",
            score: { total: 0, notes: 0, golden: 0, lineBonus: 0 },
            finished: false,
            micLost: true,
          }),
        ],
      },
      startedAtMs: 1_700_000_000_000,
      ended: "ended",
    });
    expect(outcome).toEqual({
      songId: 7,
      requestId: 5,
      noteFingerprint: "f1ng3rpr1nt",
      partyId: "party-1",
      mode: "normal",
      startedAtMs: 1_700_000_000_000,
      ended: "ended",
      scores: [
        {
          player: { kind: "profile", profileId: 11 },
          voice: 0,
          difficulty: "hard",
          total: 5000,
          notes: 4500,
          golden: 0,
          lineBonus: 500,
          micKind: "phone",
          unfinished: false,
          micLost: false,
          beatRange: { firstBeat: 0, lastBeat: 1 },
          beatValues: [{ kind: "pitch", pitch: 60 }, { kind: "noVoice" }],
        },
        {
          player: { kind: "guest", name: "Leo" },
          voice: 1,
          difficulty: "easy",
          total: 0,
          notes: 0,
          golden: 0,
          lineBonus: 0,
          micKind: "localMic",
          unfinished: true,
          micLost: true,
          beatRange: { firstBeat: 0, lastBeat: 1 },
          beatValues: [{ kind: "pitch", pitch: 60 }, { kind: "noVoice" }],
        },
      ],
    });
  });

  it("is null when a seat's member is no longer in the Party", () => {
    const party = testParty({ members: [LEO] });
    expect(
      roundOutcome({
        requestId: 5,
        songId: 7,
        party,
        memberIds: [MIA.memberId],
        scoring: { noteFingerprint: "f", players: [played()] },
        startedAtMs: 1,
        ended: "played",
      }),
    ).toBeNull();
  });
});
