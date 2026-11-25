import { describe, expect, it } from "vitest";

import type { BeatValue } from "../generated/BeatValue";
import { beatValues, type BeatReading } from "./beatValues";

/** A reading as the fixtures write it: Stage-clock capture time, not yet placed. */
interface FixtureReading extends Omit<BeatReading, "songTime"> {
  captureTime: number;
}

interface BeatValueFixture {
  description: string;
  gapSeconds: number;
  beatsPerMinute: number;
  songStartMs: number;
  micDelayMs: number;
  micThresholdDbfs: number;
  firstBeat: number;
  lastBeat: number;
  readings: FixtureReading[];
  beatValues: BeatValue[];
}

const files = import.meta.glob<string>(
  "../../../fixtures/scoring/beatValues/*.json",
  { query: "?raw", import: "default", eager: true },
);

const fixtures = Object.entries(files).map(([path, text]) => ({
  file: path.split("/").pop() ?? path,
  ...(JSON.parse(text) as BeatValueFixture),
}));

/** A steady clock: Song time = capture time − Mic delay − Song start. */
function placed(f: BeatValueFixture): BeatReading[] {
  return f.readings.map(({ captureTime, ...reading }) => ({
    ...reading,
    songTime: (captureTime - f.micDelayMs - f.songStartMs) / 1000,
  }));
}

function run(f: BeatValueFixture, readings = placed(f)): BeatValue[] {
  return beatValues({
    readings,
    micThresholdDbfs: f.micThresholdDbfs,
    grid: f,
    firstBeat: f.firstBeat,
    lastBeat: f.lastBeat,
  });
}

describe("Beat values from placed Pitch readings", () => {
  it("has fixture files", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("$file: $description", (f) => {
    expect(run(f)).toEqual(f.beatValues);
  });

  it.each(fixtures)(
    "$file: is pure (same inputs, same values, any reading order)",
    (f) => {
      const readings = placed(f);
      const before = structuredClone(readings);
      expect(run(f, [...readings].reverse())).toEqual(run(f, readings));
      expect(readings).toEqual(before);
    },
  );
});
