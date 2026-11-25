import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { StageState } from "../../live/liveState";
import { SCENE_RULES, pickScene } from "./scenes";

const party = (over: Partial<PartySnapshot> = {}): PartySnapshot => ({
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  ...over,
});

const stage = (over: Partial<StageState> = {}): StageState => ({
  stageId: "main",
  party: party(),
  isStage: true,
  stageMoved: false,
  ...over,
});

const request = {
  requestId: 1,
  kind: "song" as const,
  songId: 1,
  requestedPlayers: [],
  adder: null,
};

describe("pickScene", () => {
  it("rests on the song browser with an empty Queue", () => {
    expect(pickScene(stage())).toBe("songBrowser");
  });

  it("shows the song browser before the server has told the state", () => {
    expect(pickScene(null)).toBe("songBrowser");
    expect(pickScene(stage({ party: null }))).toBe("songBrowser");
  });

  it("shows the Line-up once the Queue has a head", () => {
    expect(
      pickScene(stage({ party: party({ queue: [request], head: 1 }) })),
    ).toBe("lineUp");
  });

  it("shows Stage moved here on a browser that stopped being the Stage", () => {
    expect(
      pickScene(
        stage({
          isStage: false,
          stageMoved: true,
          party: party({ queue: [request], head: 1 }),
        }),
      ),
    ).toBe("stageMoved");
  });
});

describe("SCENE_RULES", () => {
  it("hides the pill row and refuses overlays during a Song", () => {
    expect(SCENE_RULES.sing).toEqual({
      pillRow: false,
      setup: false,
      overlays: false,
    });
  });

  it("holds Setup in the pill row on the song browser and the Line-up only", () => {
    expect(SCENE_RULES.songBrowser.setup).toBe(true);
    expect(SCENE_RULES.lineUp.setup).toBe(true);
    expect(SCENE_RULES.results.setup).toBe(false);
    expect(SCENE_RULES.results.pillRow).toBe(true);
  });

  it("gives the old Stage no controls but its own", () => {
    expect(SCENE_RULES.stageMoved).toEqual({
      pillRow: false,
      setup: false,
      overlays: false,
    });
  });
});
