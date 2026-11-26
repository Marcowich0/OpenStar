import { describe, expect, it } from "vitest";

import {
  CALIBRATION,
  MIC_DELAY,
  MIC_THRESHOLD,
  atReferenceVolume,
  resolveMicSettings,
  storedAtStageOutput,
  volumeLevelDb,
} from "./micSettings";
import type { MicSettings } from "./micSettings";

function expectSettings(
  actual: MicSettings,
  expected: Omit<MicSettings, "thresholdSource"> & { thresholdSource: string },
) {
  const { effectiveThresholdDbfs, ...rest } = actual;
  const { effectiveThresholdDbfs: expectedDbfs, ...expectedRest } = expected;
  expect(rest).toEqual(expectedRest);
  expect(effectiveThresholdDbfs).toBeCloseTo(expectedDbfs, 3);
}

describe("the OpenStar volume's level", () => {
  it.each([
    { volume: 80, levelDb: 0 },
    { volume: 40, levelDb: -12.0412 },
    { volume: 100, levelDb: 3.8764 },
    { volume: 5, levelDb: -48.1648 },
    { volume: 0, levelDb: -48.1648 },
  ])("is $levelDb dB at volume $volume", ({ volume, levelDb }) => {
    expect(volumeLevelDb(volume)).toBeCloseTo(levelDb, 3);
  });
});

describe("a Phone's Mic settings", () => {
  const calibrated = { micDelayMs: 104, bleedLevelDbfs: -38 };

  it.each([
    {
      case: "calibrated at volume 80",
      stored: { calibration: calibrated },
      volume: 80,
      expected: {
        micDelayMs: 104,
        effectiveThresholdDbfs: -32,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      case: "calibrated at volume 40",
      stored: { calibration: calibrated },
      volume: 40,
      expected: {
        micDelayMs: 104,
        effectiveThresholdDbfs: -44.0412,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      case: "uncalibrated at volume 80",
      stored: undefined,
      volume: 80,
      expected: {
        micDelayMs: 100,
        effectiveThresholdDbfs: -30,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "uncalibrated at volume 40",
      stored: undefined,
      volume: 40,
      expected: {
        micDelayMs: 100,
        effectiveThresholdDbfs: -42.0412,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "uncalibrated at volume 0",
      stored: undefined,
      volume: 0,
      expected: {
        micDelayMs: 100,
        effectiveThresholdDbfs: -78.1648,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "uncalibrated, ignoring a reported input delay and a stored hand setting",
      stored: { micThreshold: { referenceDbfs: -50, setBy: "hand" as const } },
      reportedInputDelayMs: 12,
      volume: 80,
      expected: {
        micDelayMs: 100,
        effectiveThresholdDbfs: -30,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "calibrated, ignoring a stored hand setting",
      stored: {
        calibration: calibrated,
        micThreshold: { referenceDbfs: -50, setBy: "hand" as const },
      },
      volume: 80,
      expected: {
        micDelayMs: 104,
        effectiveThresholdDbfs: -32,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
  ])("$case", ({ stored, reportedInputDelayMs, volume, expected }) => {
    const settings = resolveMicSettings({
      kind: "phone",
      stored,
      reportedInputDelayMs,
      volume,
    });
    expectSettings(settings, expected);
  });
});

describe("a Local mic's Mic settings", () => {
  const calibration = { micDelayMs: 31, bleedLevelDbfs: -50 };

  it.each([
    {
      case: "never calibrated nor set by hand, no input delay reported",
      stored: undefined,
      reportedInputDelayMs: null,
      volume: 80,
      expected: {
        micDelayMs: 0,
        effectiveThresholdDbfs: -40,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "never calibrated nor set by hand, with a reported input delay",
      stored: {},
      reportedInputDelayMs: 12,
      volume: 80,
      expected: {
        micDelayMs: 12,
        effectiveThresholdDbfs: -40,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "never calibrated nor set by hand, at volume 40",
      stored: undefined,
      reportedInputDelayMs: 12,
      volume: 40,
      expected: {
        micDelayMs: 12,
        effectiveThresholdDbfs: -52.0412,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "never calibrated nor set by hand, at volume 0",
      stored: undefined,
      volume: 0,
      expected: {
        micDelayMs: 0,
        effectiveThresholdDbfs: -88.1648,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      case: "only set by hand: still not calibrated",
      stored: { micThreshold: { referenceDbfs: -35, setBy: "hand" as const } },
      reportedInputDelayMs: 12,
      volume: 80,
      expected: {
        micDelayMs: 12,
        effectiveThresholdDbfs: -35,
        calibrated: false,
        thresholdSource: "hand",
      },
    },
    {
      case: "set by Calibration",
      stored: {
        calibration,
        micThreshold: { referenceDbfs: -44, setBy: "calibration" as const },
      },
      reportedInputDelayMs: 12,
      volume: 80,
      expected: {
        micDelayMs: 31,
        effectiveThresholdDbfs: -44,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      case: "set by Calibration, at volume 40",
      stored: {
        calibration,
        micThreshold: { referenceDbfs: -44, setBy: "calibration" as const },
      },
      volume: 40,
      expected: {
        micDelayMs: 31,
        effectiveThresholdDbfs: -56.0412,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      case: "calibrated, then set by hand: the hand setting wins",
      stored: {
        calibration,
        micThreshold: { referenceDbfs: -38, setBy: "hand" as const },
      },
      volume: 80,
      expected: {
        micDelayMs: 31,
        effectiveThresholdDbfs: -38,
        calibrated: true,
        thresholdSource: "hand",
      },
    },
  ])("$case", ({ stored, reportedInputDelayMs, volume, expected }) => {
    const settings = resolveMicSettings({
      kind: "localMic",
      stored,
      reportedInputDelayMs,
      volume,
    });
    expectSettings(settings, expected);
  });
});

describe("a value at some volume, stored at the reference volume", () => {
  it.each([
    {
      what: "a hand setting of -40 dBFS shown",
      dbfs: -40,
      volume: 40,
      stored: -27.9588,
    },
    {
      what: "a hand setting of -40 dBFS shown",
      dbfs: -40,
      volume: 80,
      stored: -40,
    },
    {
      what: "a bleed level of -45 dBFS measured",
      dbfs: -45,
      volume: 100,
      stored: -48.8764,
    },
    {
      what: "a bleed level of -60 dBFS measured",
      dbfs: -60,
      volume: 0,
      stored: -11.8352,
    },
  ])(
    "$what at volume $volume is stored as $stored dBFS",
    ({ dbfs, volume, stored }) => {
      expect(atReferenceVolume(dbfs, volume)).toBeCloseTo(stored, 3);
    },
  );

  it.each([0, 23, 40, 80, 100])(
    "shows a Local mic's hand setting made at volume %i as it was set",
    (volume) => {
      const shownDbfs = -37;
      const settings = resolveMicSettings({
        kind: "localMic",
        stored: {
          micThreshold: {
            referenceDbfs: atReferenceVolume(shownDbfs, volume),
            setBy: "hand",
          },
        },
        volume,
      });
      expect(settings.effectiveThresholdDbfs).toBeCloseTo(shownDbfs, 9);
    },
  );
});

describe("Mic settings stored for several Stage outputs", () => {
  const phoneByOutput = {
    "Living room speakers": {
      calibration: { micDelayMs: 98, bleedLevelDbfs: -37 },
    },
    "LG TV (HDMI)": {
      calibration: { micDelayMs: 212, bleedLevelDbfs: -41 },
    },
  };
  const localMicByOutput = {
    "Living room speakers": {
      calibration: { micDelayMs: 25, bleedLevelDbfs: -50 },
      micThreshold: { referenceDbfs: -44, setBy: "calibration" as const },
    },
    "LG TV (HDMI)": {
      micThreshold: { referenceDbfs: -36, setBy: "hand" as const },
    },
  };

  it.each([
    {
      kind: "phone" as const,
      byOutput: phoneByOutput,
      stageOutput: "Living room speakers",
      expected: {
        micDelayMs: 98,
        effectiveThresholdDbfs: -31,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      kind: "phone" as const,
      byOutput: phoneByOutput,
      stageOutput: "LG TV (HDMI)",
      expected: {
        micDelayMs: 212,
        effectiveThresholdDbfs: -35,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      kind: "phone" as const,
      byOutput: phoneByOutput,
      stageOutput: "Bluetooth soundbar",
      expected: {
        micDelayMs: 100,
        effectiveThresholdDbfs: -30,
        calibrated: false,
        thresholdSource: "default",
      },
    },
    {
      kind: "localMic" as const,
      byOutput: localMicByOutput,
      stageOutput: "Living room speakers",
      expected: {
        micDelayMs: 25,
        effectiveThresholdDbfs: -44,
        calibrated: true,
        thresholdSource: "calibration",
      },
    },
    {
      kind: "localMic" as const,
      byOutput: localMicByOutput,
      stageOutput: "LG TV (HDMI)",
      expected: {
        micDelayMs: 7,
        effectiveThresholdDbfs: -36,
        calibrated: false,
        thresholdSource: "hand",
      },
    },
    {
      kind: "localMic" as const,
      byOutput: localMicByOutput,
      stageOutput: "Bluetooth soundbar",
      expected: {
        micDelayMs: 7,
        effectiveThresholdDbfs: -40,
        calibrated: false,
        thresholdSource: "default",
      },
    },
  ])(
    "a $kind at $stageOutput resolves to that output's own values",
    ({ kind, byOutput, stageOutput, expected }) => {
      const settings = resolveMicSettings({
        kind,
        stored: storedAtStageOutput(byOutput, stageOutput),
        reportedInputDelayMs: 7,
        volume: 80,
      });
      expect(settings).toEqual(expected);
    },
  );
});

describe("the Calibration and Mic threshold constants", () => {
  it("hold the Mic threshold values", () => {
    expect(MIC_THRESHOLD).toEqual({
      bleedMarginDb: 6,
      phoneFallbackDbfs: -30,
      localMicDefaultDbfs: -40,
      referenceVolume: 80,
    });
  });

  it("hold the Phone default Mic delay", () => {
    expect(MIC_DELAY).toEqual({ phoneDefaultMs: 100 });
  });

  it("hold the Calibration run and its acceptance rules", () => {
    expect(CALIBRATION).toEqual({
      toneCount: 8,
      toneDurationMs: 200,
      toneFrequencyHz: 440,
      toneOnsetSpacingMs: 600,
      toneLoudnessLufs: -18,
      readingWindowStartMs: -150,
      readingWindowEndMs: 700,
      onsetSilenceMs: 200,
      pitchToleranceCents: 50,
      minClarity: 0.8,
      minTonesHeard: 5,
      maxDelayStandardDeviationMs: 25,
      bleedLevelPercentile: 95,
    });
  });
});
