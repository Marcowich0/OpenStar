import { describe, expect, it } from "vitest";

import type { PitchReading } from "../generated/PitchReading";
import {
  analyseCalibration,
  calibrationResult,
  type MicCalibration,
} from "./calibrationAnalysis";

/** `[captureMs, pitch, clarity, loudness]`, as in `fixtures/calibration/README.md`. */
type FixtureReading = [number, number | null, number, number];

interface CalibrationFixture {
  description: string;
  toneOutputTimesMs: number[];
  volume: number;
  mics: {
    name: string;
    comment?: string;
    readings: FixtureReading[];
    expected: MicCalibration;
  }[];
}

const files = import.meta.glob<string>("../../../fixtures/calibration/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const fixtures = Object.entries(files).map(([path, text]) => ({
  file: path.split("/").pop() ?? path,
  ...(JSON.parse(text) as CalibrationFixture),
}));

function toReading([
  captureMs,
  pitch,
  clarity,
  loudness,
]: FixtureReading): PitchReading {
  return { captureMs, pitch, clarity, loudness };
}

describe("analyseCalibration", () => {
  it("runs every fixture file", () => {
    expect(fixtures.map((f) => f.file).sort()).toEqual([
      "bleed.json",
      "chatter.json",
      "clean.json",
      "long-delay.json",
      "overlap.json",
      "spread.json",
      "tones-heard.json",
    ]);
  });

  describe.each(fixtures)("$file", (fixture) => {
    it.each(fixture.mics)("$name", (mic) => {
      const [result] = analyseCalibration({
        toneOutputTimesMs: fixture.toneOutputTimesMs,
        volume: fixture.volume,
        mics: [{ mic: mic.name, readings: mic.readings.map(toReading) }],
      });

      expect(result?.mic).toBe(mic.name);
      const outcome = result?.outcome;
      const expected = mic.expected;
      if (
        expected.result === "calibrated" &&
        outcome?.result === "calibrated"
      ) {
        const { bleedLevelDbfs, ...rest } = outcome;
        const { bleedLevelDbfs: expectedBleed, ...expectedRest } = expected;
        expect(rest).toEqual(expectedRest);
        expect(bleedLevelDbfs).toBeCloseTo(expectedBleed, 6);
      } else {
        // A failure carries exactly its reason and the tones heard: no Mic
        // delay, bleed level or Mic threshold.
        expect(outcome).toEqual(expected);
      }
    });
  });

  it("analyses every chosen Mic of a run, in the order given", () => {
    const clean = fixtures.find((f) => f.file === "tones-heard.json");
    if (!clean) throw new Error("tones-heard.json is missing");
    const results = analyseCalibration({
      toneOutputTimesMs: clean.toneOutputTimesMs,
      volume: clean.volume,
      mics: clean.mics.map((m) => ({
        mic: m.name,
        readings: m.readings.map(toReading),
      })),
    });
    expect(results.map((r) => [r.mic, r.outcome.result])).toEqual([
      ["four tones", "failed"],
      ["five tones", "calibrated"],
      ["no tones", "failed"],
    ]);
  });
});

describe("calibrationResult", () => {
  const calibrated = {
    result: "calibrated",
    micDelayMs: 112,
    bleedLevelDbfs: -41.5,
    tonesHeard: 8,
  } as const;

  it("stores a Phone's Mic delay and bleed level, and no Mic threshold", () => {
    expect(
      calibrationResult({ kind: "phone", phoneId: "p1" }, calibrated),
    ).toEqual({
      mic: { kind: "phone", phoneId: "p1" },
      micDelayMs: 112,
      bleedLevelDbfs: -41.5,
    });
  });

  it("stores a Local mic's Mic threshold at its bleed level + 6 dB", () => {
    expect(
      calibrationResult({ kind: "localMic", localMicId: "m1" }, calibrated),
    ).toEqual({
      mic: { kind: "localMic", localMicId: "m1" },
      micDelayMs: 112,
      bleedLevelDbfs: -41.5,
      micThresholdDbfs: -35.5,
    });
  });
});
