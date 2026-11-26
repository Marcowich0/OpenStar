import { describe, expect, it } from "vitest";

import { PitchBuffer } from "../../../pitch/pitchBuffer";
import {
  MIC_THRESHOLD,
  type StoredMicSettings,
} from "../../../mics/micSettings";
import { stageMicSettings } from "../../../mics/stageMicSettings";
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
    // Nothing stored: the defaults at the reference volume.
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

  it("routes a seated Phone's readings by its Phone id and a seated Local mic's by its Local mic id", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
    });
    expect(setup.mics).toEqual([
      [{ kind: "phone", phoneId: "phone-mia" }, 0],
      [{ kind: "localMic", localMicId: "browser:s:dongle:0" }, 1],
    ]);
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

  it("sings uncalibrated Mics on the defaults: a Phone 100 ms and −30 dBFS, a Local mic 0 ms and −40 dBFS at volume 80", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
      storedFor: () => undefined,
      volume: 80,
    });
    expect(
      setup.players.map((p) => [p.micDelayMs, p.micThresholdDbfs]),
    ).toEqual([
      [100, -30],
      [0, -40],
    ]);
  });

  it("gives an uncalibrated Local mic its reported input delay as its Mic delay until it is calibrated", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const reportedInputDelayFor = (localMicId: string) =>
      localMicId === "browser:s:dongle:0" ? 9.5 : null;
    const uncalibrated = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
      storedFor: () => undefined,
      reportedInputDelayFor,
      volume: 80,
    });
    // A Phone has no reported input delay; it keeps its 100 ms default.
    expect(uncalibrated.players.map((p) => p.micDelayMs)).toEqual([100, 9.5]);
    const calibrated = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
      storedFor: (mic): StoredMicSettings | undefined =>
        mic.kind === "localMic"
          ? { calibration: { micDelayMs: 14, bleedLevelDbfs: -60 } }
          : undefined,
      reportedInputDelayFor,
      volume: 80,
    });
    expect(calibrated.players[1]?.micDelayMs).toBe(14);
  });

  it("reads the Local mics' reported input delays the Stage holds by default", () => {
    const party = testParty({ lineUp: testLineUp([LEO_SEAT]) });
    stageMicSettings().setReportedInputDelays(
      new Map([["browser:s:dongle:0", 7]]),
    );
    try {
      const setup = singSetup({
        detail: testDetail(),
        party,
        profiles: PROFILES,
        storedFor: () => undefined,
        volume: 80,
      });
      expect(setup.players[0]?.micDelayMs).toBe(7);
    } finally {
      stageMicSettings().setReportedInputDelays(new Map());
    }
  });

  it("gives each seated Mic its values stored at the current Stage output, at the volume of Start", () => {
    const party = testParty({ lineUp: testLineUp([MIA_SEAT, LEO_SEAT], true) });
    const setup = singSetup({
      detail: testDetail({ duet: true }),
      party,
      profiles: PROFILES,
      storedFor: (mic): StoredMicSettings | undefined =>
        mic.kind === "phone"
          ? { calibration: { micDelayMs: 180, bleedLevelDbfs: -42 } }
          : {
              calibration: { micDelayMs: 12, bleedLevelDbfs: -60 },
              micThreshold: { referenceDbfs: -54, setBy: "calibration" },
            },
      volume: 40,
    });
    const level = 40 * Math.log10(40 / 80);
    expect(setup.players[0]?.micDelayMs).toBe(180);
    expect(setup.players[0]?.micThresholdDbfs).toBeCloseTo(-36 + level);
    expect(setup.players[1]?.micDelayMs).toBe(12);
    expect(setup.players[1]?.micThresholdDbfs).toBeCloseTo(-54 + level);
    // The trace colours its hits by the same threshold the scorer gets.
    const state = setup.state(setup.players.map(() => new PitchBuffer(8)));
    expect(state.lanes.map((lane) => lane.trace?.micThresholdDbfs)).toEqual(
      setup.players.map((p) => p.micThresholdDbfs),
    );
  });

  it("reads the Stage's loaded Mic settings by default", () => {
    stageMicSettings().set({
      stageOutput: "Speakers",
      mics: [
        {
          mic: { kind: "phone", phoneId: "phone-mia" },
          settings: { calibration: { micDelayMs: 150, bleedLevelDbfs: -50 } },
        },
      ],
    });
    try {
      const setup = singSetup({
        detail: testDetail(),
        party: testParty(),
        profiles: PROFILES,
        volume: 80,
      });
      expect(setup.players[0]?.micDelayMs).toBe(150);
      expect(setup.players[0]?.micThresholdDbfs).toBe(-44);
    } finally {
      stageMicSettings().set(null);
    }
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
