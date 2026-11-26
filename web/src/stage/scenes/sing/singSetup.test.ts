import { describe, expect, it } from "vitest";

import { PitchBuffer } from "../../../pitch/pitchBuffer";
import { MIC_THRESHOLD } from "../../../mics/micSettings";
import { singSetup } from "./singSetup";
import {
  LEO_SEAT,
  MIA_SEAT,
  PROFILES,
  testDetail,
  testLineUp,
  testParty,
} from "./testSong";

describe("the sing screen's state, built from the Line-up fixed at Start", () => {
  it("gives each seat a lane in its Party colour, on its Voice, at its Difficulty", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
    });

    expect(setup.players).toEqual([
      expect.objectContaining({ memberId: 1, colour: "cherry", voice: 0 }),
      expect.objectContaining({ memberId: 2, colour: "sky", voice: 1 }),
    ]);
    const state = setup.state(setup.players.map(() => new PitchBuffer(8)));
    expect(state.voices).toHaveLength(2);
    expect(state.lanes.map((lane) => [lane.colour, lane.voice])).toEqual([
      ["cherry", 0],
      ["sky", 1],
    ]);
    expect(state.lanes.map((lane) => lane.player)).toEqual([
      {
        name: "Mia",
        avatar: { kind: "builtIn", key: "star" },
        guest: false,
        score: 0,
      },
      {
        name: "Leo",
        avatar: { kind: "builtIn", key: "cat" },
        guest: true,
        score: 0,
      },
    ]);
    expect(state.lanes.map((lane) => lane.trace?.difficulty)).toEqual([
      "hard",
      "easy",
    ]);
    expect(state.lengthSeconds).toBe(30);
    expect(state.effects).toBeDefined();
  });

  it("puts each Player's own buffer in their lane's trace, with the Mic threshold fixed at Start", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
    });
    const buffers = [new PitchBuffer(8), new PitchBuffer(8)];
    const state = setup.state(buffers);

    expect(state.lanes[0]?.trace?.readings).toBe(buffers[0]);
    expect(state.lanes[1]?.trace?.readings).toBe(buffers[1]);
    // Nothing stored yet (#169 applies the stored values): the defaults at
    // the reference volume.
    expect(state.lanes[0]?.trace?.micThresholdDbfs).toBe(
      MIC_THRESHOLD.phoneFallbackDbfs,
    );
    expect(state.lanes[1]?.trace?.micThresholdDbfs).toBe(
      MIC_THRESHOLD.localMicDefaultDbfs,
    );
    expect(state.lanes.map((lane) => lane.trace?.lostAt)).toEqual([null, null]);
  });

  it("sings a one-Voice Song's every seat on that Voice", () => {
    const party = testParty({
      lineUp: testLineUp([MIA_SEAT, { ...LEO_SEAT, voice: "p1" }]),
    });
    const setup = singSetup({
      detail: testDetail(),
      party,
      profiles: PROFILES,
    });
    expect(setup.players.map((p) => p.voice)).toEqual([0, 0]);
  });

  it("routes each seated Mic it can name on the wire to its Player", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
      micIdFor: (mic) =>
        mic.kind === "localMic" ? { kind: "phone", phoneId: "phone-9" } : null,
    });
    expect(setup.mics).toEqual([[{ kind: "phone", phoneId: "phone-9" }, 1]]);
  });

  it("routes a seated Phone's readings, which arrive under its Phone id, to its Player", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
    });
    // Leo's Local mic relays no readings yet (#130 / #151).
    expect(setup.mics).toEqual([[{ kind: "phone", phoneId: "phone-mia" }, 0]]);
  });

  it("gives each Player their Mic kind and the buffers' capacity", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
    });
    expect(setup.players.map((p) => p.micKind)).toEqual(["phone", "localMic"]);
    expect(setup.capacity).toBeGreaterThan(0);
  });

  it("refuses a Party with no Line-up", () => {
    expect(() =>
      singSetup({
        detail: testDetail(),
        party: testParty({ lineUp: null }),
        profiles: PROFILES,
      }),
    ).toThrow();
  });
});
