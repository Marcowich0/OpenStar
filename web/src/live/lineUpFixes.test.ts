import { describe, expect, it } from "vitest";

import type { LineUp } from "../generated/LineUp";
import type { LineUpWarning } from "../generated/LineUpWarning";
import type { Seat } from "../generated/Seat";
import type { SeatVoice } from "../generated/SeatVoice";
import { blocksStart, lineUpFix, NO_FIX } from "./lineUpFixes";

const seat = (memberId: number, voice: SeatVoice = "p1"): Seat => ({
  memberId,
  mic: { kind: "phone", phoneId: `ph-${String(memberId)}` },
  voice,
  difficulty: "medium",
});

const lineUp = (seats: Seat[], duet = false): LineUp => ({
  requestId: 1,
  duet,
  seats,
  canStart: false,
  warnings: [],
});

/**
 * One warning of every code the Line-up can show. A new code fails `tsc`
 * here until a sample (and so a decision about its fix) is added.
 */
const SAMPLES: {
  [C in LineUpWarning["code"]]: Extract<LineUpWarning, { code: C }>;
} = {
  noMic: { code: "noMic", params: { memberId: 2 } },
  micBlocked: { code: "micBlocked", params: { memberId: 2 } },
  localMicUnplugged: {
    code: "localMicUnplugged",
    params: { memberId: 2, localMicId: "red" },
  },
  bridgeClosed: {
    code: "bridgeClosed",
    params: { memberId: 2, localMicId: "red", hostName: "den" },
  },
  localMicSilent: {
    code: "localMicSilent",
    params: { memberId: 2, localMicId: "red" },
  },
  duetNeedsVoice: { code: "duetNeedsVoice", params: { voice: "p2" } },
  notCalibrated: { code: "notCalibrated", params: { memberId: 2 } },
};

describe("a Line-up warning's fix", () => {
  it("exists for every warning code, unless the code is listed as having none", () => {
    const twoSeats = lineUp([seat(1), seat(2)], true);
    for (const warning of Object.values(SAMPLES)) {
      const fix = lineUpFix(warning, twoSeats);
      if (NO_FIX.includes(warning.code)) expect(fix).toBeNull();
      else expect(fix, warning.code).not.toBeNull();
    }
  });

  it("opens the warned seat's Mic list for every Mic problem", () => {
    const twoSeats = lineUp([seat(1), seat(2)]);
    for (const code of [
      "noMic",
      "micBlocked",
      "localMicUnplugged",
      "bridgeClosed",
      "localMicSilent",
    ] as const) {
      expect(lineUpFix(SAMPLES[code], twoSeats), code).toEqual({
        kind: "pickMic",
        seat: 1,
      });
    }
  });

  it("opens the calibration for 'Not calibrated'", () => {
    expect(
      lineUpFix(SAMPLES.notCalibrated, lineUp([seat(1), seat(2)])),
    ).toEqual({ kind: "calibrate", seat: 1 });
  });

  it("has none for a member who sits in no seat", () => {
    expect(lineUpFix(SAMPLES.noMic, lineUp([seat(1)]))).toBeNull();
  });

  it("has no calibration for a seat without a Mic", () => {
    expect(
      lineUpFix(
        SAMPLES.notCalibrated,
        lineUp([seat(1), { ...seat(2), mic: null }]),
      ),
    ).toBeNull();
  });

  it("switches the last seat's Voice when a duet's other Voice has two or more singers", () => {
    expect(
      lineUpFix(
        SAMPLES.duetNeedsVoice,
        lineUp([seat(1), seat(2), seat(3)], true),
      ),
    ).toEqual({ kind: "pickVoice", seat: 2 });
  });

  it("adds a singer when a duet has one singer", () => {
    expect(lineUpFix(SAMPLES.duetNeedsVoice, lineUp([seat(1)], true))).toEqual({
      kind: "addSinger",
    });
  });

  it("knows which warnings block Start, as the protocol documents them", () => {
    const blocking = Object.values(SAMPLES)
      .filter((warning) => blocksStart(warning))
      .map((warning) => warning.code);
    expect(blocking).toEqual(["noMic", "duetNeedsVoice"]);
  });
});
