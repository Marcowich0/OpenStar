/**
 * The Beat-value regression runs (#58, ticket #226): the Pitch readings saved
 * by the Phone mic latency prototype, replayed through the Stage's Beat-value
 * computation on a 50 ms Beat grid, as in the replay that set the scoring
 * thresholds (#22). Format and rules: `fixtures/readings/README.md`.
 */

import { describe, expect, it } from "vitest";

import type { BeatGrid } from "../clock/beats";
import type { BeatValue } from "../generated/BeatValue";
import { MIC_THRESHOLD } from "../mics/micSettings";
import { beatValues, type BeatReading } from "./beatValues";
import { beatHits } from "./scorer";

type RunKind = "bleed" | "singing";

interface ReadingsRun {
  kind: RunKind;
  source: { commit: string; file: string; test: string };
  micKind: "phone";
  micDelayMs: number;
  notes: { startMs: number; endMs: number; midi: number }[];
  readingColumns: ["captureMs", "pitch", "clarity", "loudness"];
  readings: [number, number | null, number, number][];
}

interface Floors {
  bleedHitBeatsMaxPct: number;
  singingVoicedBeatsMinPct: number;
}

const files = import.meta.glob<string>(
  "../../../fixtures/readings/run-*.json",
  { query: "?raw", import: "default", eager: true },
);
const floorsText = Object.values(
  import.meta.glob<string>("../../../fixtures/readings/floors.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

const runs = Object.entries(files).map(([path, text]) => ({
  file: path.split("/").pop() ?? path,
  ...(JSON.parse(text) as ReadingsRun),
}));

const BEAT_MS = 50;
/** `#GAP:0`, and a `#BPM` whose Beat lasts 50 ms. */
const GRID: BeatGrid = { gapSeconds: 0, beatsPerMinute: 60_000 / BEAT_MS };
/** The prototype counted a reading as a hit within ±150 cents: Medium. */
const DIFFICULTY = "medium";

/** One Beat inside a Note, with the Note's pitch (0 = C4). */
interface NoteBeat {
  beat: number;
  pitch: number;
}

function noteBeats(run: ReadingsRun): NoteBeat[] {
  return run.notes.flatMap(({ startMs, endMs, midi }) => {
    const first = startMs / BEAT_MS;
    const length = (endMs - startMs) / BEAT_MS;
    if (!Number.isInteger(first) || !Number.isInteger(length)) {
      throw new Error(`Note ${startMs}–${endMs} ms is off the 50 ms grid`);
    }
    return Array.from({ length }, (_, i) => ({
      beat: first + i,
      pitch: midi - 60,
    }));
  });
}

/** A steady clock: Song time = (capture time − Mic delay) / 1000. */
function placed(run: ReadingsRun): BeatReading[] {
  return run.readings.map(([captureMs, pitch, clarity, loudness]) => ({
    pitch,
    clarity,
    loudness,
    songTime: (captureMs - run.micDelayMs) / 1000,
  }));
}

interface Replay {
  beats: number;
  hitPct: number;
  voicedPct: number;
}

function replay(run: ReadingsRun, micThresholdDbfs: number): Replay {
  const beats = noteBeats(run);
  const firstBeat = Math.min(...beats.map((b) => b.beat));
  const lastBeat = Math.max(...beats.map((b) => b.beat));
  const values = beatValues({
    readings: placed(run),
    micThresholdDbfs,
    grid: GRID,
    firstBeat,
    lastBeat,
  });
  const valueOf = (beat: number): BeatValue =>
    values[beat - firstBeat] ?? { kind: "noVoice" };
  const hits = beats.filter(({ beat, pitch }) =>
    beatHits({ kind: "normal", pitch }, valueOf(beat), DIFFICULTY),
  ).length;
  const voiced = beats.filter(
    ({ beat }) => valueOf(beat).kind === "pitch",
  ).length;
  return {
    beats: beats.length,
    hitPct: (100 * hits) / beats.length,
    voicedPct: (100 * voiced) / beats.length,
  };
}

const PHONE_FALLBACK = MIC_THRESHOLD.phoneFallbackDbfs;
const bleedRuns = runs.filter((r) => r.kind === "bleed");
const singingRuns = runs.filter((r) => r.kind === "singing");

describe("Beat-value regression runs over recorded Pitch readings", () => {
  it("has the six saved prototype files, every run labelled and sourced", () => {
    expect(new Set(runs.map((r) => r.source.file)).size).toBe(6);
    for (const run of runs) {
      expect(["bleed", "singing"]).toContain(run.kind);
      expect(run.source.commit).toMatch(/^b61f2dc/);
      expect(run.readings.length).toBeGreaterThan(1000);
    }
    expect(bleedRuns.length).toBeGreaterThan(0);
    expect(singingRuns.length).toBeGreaterThan(0);
  });

  it("replays at the Phone fallback Mic threshold of −30 dBFS", () => {
    expect(PHONE_FALLBACK).toBe(-30);
  });

  it("has a committed floor", () => {
    expect(floorsText).toBeDefined();
  });

  const floors = JSON.parse(floorsText ?? "{}") as Floors;

  it.each(bleedRuns)(
    "$file: Bleed hits at most the allowed share of Beats",
    (run) => {
      expect(floors.bleedHitBeatsMaxPct).toBe(4);
      expect(replay(run, PHONE_FALLBACK).hitPct).toBeLessThanOrEqual(
        floors.bleedHitBeatsMaxPct,
      );
    },
  );

  it.each(bleedRuns)(
    "$file: without the Mic threshold the Bleed would hit",
    (run) => {
      // Shows the runs discriminate: the Mic threshold, not missing readings,
      // keeps Bleed from scoring (#22 measured 88–100 % without a gate).
      expect(replay(run, -Infinity).hitPct).toBeGreaterThan(50);
    },
  );

  it.each(singingRuns)(
    "$file: singing stays voiced at or above the floor",
    (run) => {
      expect(replay(run, PHONE_FALLBACK).voicedPct).toBeGreaterThanOrEqual(
        floors.singingVoicedBeatsMinPct,
      );
    },
  );
});
