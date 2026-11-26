import { describe, expect, it } from "vitest";

import type { PlayerResult } from "../../generated/PlayerResult";
import type { SongResults } from "../../generated/SongResults";
import { myResult } from "./myResult";

function result(memberId: number, mic: PlayerResult["mic"]): PlayerResult {
  return {
    memberId,
    player: { kind: "guest", name: `G${String(memberId)}` },
    name: `G${String(memberId)}`,
    avatar: { kind: "builtIn", key: "star" },
    colour: "cherry",
    mic,
    voice: null,
    difficulty: "medium",
    total: 0,
    notes: 0,
    golden: 0,
    lineBonus: 0,
    place: 1,
    rankTitleBand: 0,
    newHighScore: false,
    micLost: false,
    unfinished: false,
  };
}

const RESULTS: SongResults = {
  requestId: 1,
  songId: 2,
  ended: "played",
  players: [
    result(1, { kind: "localMic", localMicId: "phone-a" }),
    result(2, { kind: "phone", phoneId: "phone-a" }),
    result(3, null),
  ],
};

describe("a Phone's own result", () => {
  it("is the result of the Player this Phone was the Mic of", () => {
    expect(myResult(RESULTS, "phone-a")?.memberId).toBe(2);
  });

  it("is none for a Phone that was nobody's Mic, or with no results", () => {
    expect(myResult(RESULTS, "phone-b")).toBeNull();
    expect(myResult(null, "phone-a")).toBeNull();
  });
});
