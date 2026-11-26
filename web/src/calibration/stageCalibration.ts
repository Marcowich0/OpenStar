/**
 * The Stage's part of a Calibrate mics run (v1 spec #52, ticket #170): once
 * the server says the tones start, the Stage plays them (`playToneRun`),
 * gathers the Pitch readings each Mic in the run sends meanwhile (relayed,
 * window-centre stamps on the Stage's clock), runs the Calibration analysis
 * and reports only the successes with `finishCalibration`. The server stores
 * them against the Stage output in effect when the run started; every other
 * Mic in the run failed and keeps its values.
 */

import type { LiveStore } from "../live/liveStore";
import type { MicKey } from "../generated/MicKey";
import type { PitchReading } from "../generated/PitchReading";
import { CALIBRATION } from "../mics/micSettings";
import { analyseCalibration, calibrationResult } from "./calibrationAnalysis";
import type { ToneRun } from "./toneRun";

export type CalibrationStore = Pick<LiveStore, "send" | "onPitchReading">;

/**
 * How long the Stage keeps listening after the last tone has played: a
 * reading counts up to `readingWindowEndMs` after its tone, and a relayed
 * reading arrives a little after it was captured.
 */
export const LISTEN_AFTER_TONES_MS = CALIBRATION.readingWindowEndMs + 500;

export interface CalibrationTones {
  store: CalibrationStore;
  /** The Mics taking part in the run. */
  mics: readonly MicKey[];
  /** Plays the tones (`playToneRun` on the Stage's gain chain). */
  playTones: (options: { signal?: AbortSignal }) => Promise<ToneRun>;
  /** Waits `ms`; tests pass one that returns at once. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted when the run ends before the analysis: nothing is reported. */
  signal: AbortSignal;
}

function sameMic(a: MicKey, phoneId: string): boolean {
  return a.kind === "phone" && a.phoneId === phoneId;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Plays the tones, analyses what each Mic heard and reports the successes. */
export async function runCalibrationTones({
  store,
  mics,
  playTones,
  wait = waitFor,
  signal,
}: CalibrationTones): Promise<void> {
  const readings = mics.map(() => [] as PitchReading[]);
  const stop = store.onPitchReading((from, reading) => {
    const index = mics.findIndex((mic) => sameMic(mic, from.phoneId));
    if (index >= 0) readings[index]?.push(reading);
  });
  try {
    let run: ToneRun | null = null;
    try {
      run = await playTones({ signal });
      await wait(LISTEN_AFTER_TONES_MS, signal);
    } catch {
      // The Stage could not play the tones: no Mic heard them.
    }
    if (signal.aborted) return;
    if (!run) {
      store.send({ type: "finishCalibration", results: [] });
      return;
    }
    const outcomes = analyseCalibration({
      toneOutputTimesMs: run.toneOutputTimesMs,
      volume: run.volume,
      mics: mics.map((mic, index) => ({
        mic,
        readings: readings[index] ?? [],
      })),
    });
    store.send({
      type: "finishCalibration",
      results: outcomes.flatMap(({ mic, outcome }) =>
        outcome.result === "calibrated"
          ? [calibrationResult(mic, outcome)]
          : [],
      ),
    });
  } finally {
    stop();
  }
}
