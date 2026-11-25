/**
 * Calibration analysis (v1 spec #52, ticket #95): from the tone schedule and
 * each chosen Mic's Pitch readings, each Mic's Mic delay and bleed level, or
 * why it failed. It stores nothing; the caller stores only successes (with
 * `calibrationResult`), so a failed Mic keeps its previous values.
 */

import type { CalibrationResult } from "../generated/CalibrationResult";
import type { MicKey } from "../generated/MicKey";
import type { PitchReading } from "../generated/PitchReading";
import {
  atReferenceVolume,
  CALIBRATION,
  MIC_THRESHOLD,
} from "../mics/micSettings";

/** A4 as a MIDI note number. */
const A4_MIDI = 69;

export interface CalibrationRun<M> {
  /** Each tone's reported output time on the Stage's clock, ms, in order. */
  toneOutputTimesMs: readonly number[];
  /** The OpenStar volume during the run, 0 to 100. */
  volume: number;
  /** Each chosen Mic and every Pitch reading it sent during the run. */
  mics: readonly { mic: M; readings: readonly PitchReading[] }[];
}

export type CalibrationFailure = "tooFewTones" | "delaysTooSpread";

export type MicCalibration =
  | {
      result: "calibrated";
      micDelayMs: number;
      /** At the reference volume. */
      bleedLevelDbfs: number;
      tonesHeard: number;
    }
  | { result: "failed"; reason: CalibrationFailure; tonesHeard: number };

/** Each chosen Mic's outcome, in the order the run gave them. */
export function analyseCalibration<M>(
  run: CalibrationRun<M>,
): { mic: M; outcome: MicCalibration }[] {
  return run.mics.map(({ mic, readings }) => ({
    mic,
    outcome: analyseMic(run.toneOutputTimesMs, run.volume, readings),
  }));
}

/** What a successful Calibration stores for a Mic (a Local mic also gets its Mic threshold). */
export function calibrationResult(
  mic: MicKey,
  calibrated: Extract<MicCalibration, { result: "calibrated" }>,
): CalibrationResult {
  const result: CalibrationResult = {
    mic,
    micDelayMs: calibrated.micDelayMs,
    bleedLevelDbfs: calibrated.bleedLevelDbfs,
  };
  if (mic.kind === "localMic") {
    result.micThresholdDbfs =
      calibrated.bleedLevelDbfs + MIC_THRESHOLD.bleedMarginDb;
  }
  return result;
}

function analyseMic(
  tones: readonly number[],
  volume: number,
  readings: readonly PitchReading[],
): MicCalibration {
  // The earliest counting reading per tone.
  const onsets: (number | undefined)[] = tones.map(() => undefined);
  for (const reading of readings) {
    if (!countsAsTone(reading)) continue;
    const tone = toneFor(tones, reading.captureMs);
    if (tone === undefined) continue;
    const onset = onsets[tone];
    if (onset === undefined || reading.captureMs < onset) {
      onsets[tone] = reading.captureMs;
    }
  }

  const delays: number[] = [];
  onsets.forEach((onset, tone) => {
    const output = tones[tone];
    if (onset !== undefined && output !== undefined)
      delays.push(onset - output);
  });
  const tonesHeard = delays.length;

  if (tonesHeard < CALIBRATION.minTonesHeard) {
    return { result: "failed", reason: "tooFewTones", tonesHeard };
  }
  if (
    sampleStandardDeviation(delays) > CALIBRATION.maxDelayStandardDeviationMs
  ) {
    return { result: "failed", reason: "delaysTooSpread", tonesHeard };
  }

  const micDelayMs = median(delays);
  const duringTones = readings
    .filter((r) => {
      const heardAt = r.captureMs - micDelayMs;
      return tones.some(
        (t) => heardAt >= t && heardAt < t + CALIBRATION.toneDurationMs,
      );
    })
    .map((r) => r.loudness);

  return {
    result: "calibrated",
    micDelayMs,
    bleedLevelDbfs: atReferenceVolume(
      nearestRankPercentile(duringTones, CALIBRATION.bleedLevelPercentile),
      volume,
    ),
    tonesHeard,
  };
}

/** On A4 (octave folded, within the tolerance) and clear enough. */
function countsAsTone(reading: PitchReading): boolean {
  if (reading.pitch === null || reading.clarity < CALIBRATION.minClarity) {
    return false;
  }
  const cents = (reading.pitch - A4_MIDI) * 100;
  const folded = cents - 1200 * Math.round(cents / 1200);
  return Math.abs(folded) <= CALIBRATION.pitchToleranceCents;
}

/** The latest tone whose window holds the capture time, if any. */
function toneFor(
  tones: readonly number[],
  captureMs: number,
): number | undefined {
  for (let i = tones.length - 1; i >= 0; i--) {
    const offset = captureMs - (tones[i] ?? Number.NaN);
    if (
      offset >= CALIBRATION.readingWindowStartMs &&
      offset <= CALIBRATION.readingWindowEndMs
    ) {
      return i;
    }
  }
  return undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? Number.NaN;
  return sorted.length % 2 === 1
    ? upper
    : ((sorted[mid - 1] ?? Number.NaN) + upper) / 2;
}

/** Divided by n − 1, as in the measurements the 25 ms limit comes from. */
function sampleStandardDeviation(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squares = values.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/**
 * The ⌈p/100 · n⌉-th smallest value. Never empty for a Mic that passed: with
 * at least 5 tones and a spread of at most 25 ms, the first counting reading
 * of every tone heard no earlier than the median lies inside its tone.
 */
function nearestRankPercentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}
