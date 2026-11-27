/**
 * The Beat-value computation: the first pure step of scoring (#54).
 *
 * Pitch readings already placed on Song time, one Mic's fixed Mic threshold
 * and the Song's Beat grid → one Beat value per Beat. It knows neither the
 * Note nor the Difficulty, so the value is the same at every Difficulty and is
 * exactly what a Score record stores. No clock, media element or audio: the
 * same inputs always give the same values.
 */

import { beatAt, type BeatGrid } from "../clock/beats";
import type { BeatValue } from "../generated/BeatValue";
import type { PitchReading } from "../generated/PitchReading";
import { SCORING, readingsNeeded } from "./constants";

/** A Pitch reading placed on Song time (seconds), as `placeReading` returns it. */
export type BeatReading = Pick<
  PitchReading,
  "pitch" | "clarity" | "loudness"
> & {
  songTime: number;
};

export interface BeatValuesInput {
  /** One Mic's placed readings, in any order. */
  readings: readonly BeatReading[];
  /** The Mic's effective Mic threshold, fixed from Start (dBFS). */
  micThresholdDbfs: number;
  /** `#GAP` and `#BPM`: Beat b spans `[start of b, start of b + 1)`. */
  grid: BeatGrid;
  /** The Beat range, inclusive; readings outside it are ignored. */
  firstBeat: number;
  lastBeat: number;
}

/** Whether `reading` is at or above the Mic threshold. */
export function passesMicThreshold(
  reading: Pick<BeatReading, "loudness">,
  micThresholdDbfs: number,
): boolean {
  return reading.loudness >= micThresholdDbfs;
}

/**
 * Whether `reading` is voiced: it passes the Mic threshold and its clarity is
 * at least 0.8. A reading without a pitch is never voiced.
 */
export function isVoiced(
  reading: Pick<BeatReading, "pitch" | "clarity" | "loudness">,
  micThresholdDbfs: number,
): boolean {
  return (
    reading.pitch !== null &&
    passesMicThreshold(reading, micThresholdDbfs) &&
    reading.clarity >= SCORING.voicedMinClarity
  );
}

/** One value per Beat from `firstBeat` to `lastBeat`, in order. */
export function beatValues(input: BeatValuesInput): BeatValue[] {
  const { readings, micThresholdDbfs, grid, firstBeat, lastBeat } = input;
  const byBeat: BeatReading[][] = [];
  for (let b = firstBeat; b <= lastBeat; b++) byBeat.push([]);
  for (const reading of readings) {
    const beat = beatAt(grid, reading.songTime);
    if (beat >= firstBeat && beat <= lastBeat) {
      byBeat[beat - firstBeat]?.push(reading);
    }
  }
  return byBeat.map((beat) => beatValue(beat, micThresholdDbfs));
}

/**
 * The value of one Beat from every reading that falls in it (the live scorer
 * collects a Beat's readings itself and finalises it with this).
 */
export function beatValue(
  readings: readonly BeatReading[],
  micThresholdDbfs: number,
): BeatValue {
  const n = readings.length;
  if (n === 0) return { kind: "noVoice" };
  const needed = readingsNeeded(n);
  const voiced = readings.flatMap((r) =>
    r.pitch !== null && isVoiced(r, micThresholdDbfs) ? [r.pitch] : [],
  );
  if (voiced.length >= needed) {
    return { kind: "pitch", pitch: lowerMedian(voiced) };
  }
  const loud = readings.filter((r) =>
    passesMicThreshold(r, micThresholdDbfs),
  ).length;
  return loud >= needed ? { kind: "voiceWithoutPitch" } : { kind: "noVoice" };
}

/**
 * The lower median: sorted ascending, the one at index ⌊(k − 1) / 2⌋. Always
 * an actual reading, so an octave pair gives the lower one, never a tritone-off
 * mean.
 */
function lowerMedian(pitches: number[]): number {
  const sorted = [...pitches].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? NaN;
}
