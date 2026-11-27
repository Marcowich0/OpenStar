/**
 * The Stage's part of a Calibrate mics run (v1 spec #52, ticket #170): once
 * the server says the tones start, the Stage plays them (`playToneRun`),
 * gathers the Pitch readings each Mic in the run sends meanwhile (a Phone's
 * or a Mic bridge's relayed, the Stage browser's own Local mics' from its
 * capture; window-centre stamps on the Stage's clock), runs the Calibration analysis
 * and reports only the successes with `finishCalibration`. The server stores
 * them against the Stage output in effect when the run started; every other
 * Mic in the run failed and keeps its values.
 */

import type { LiveStore } from "../live/liveStore";
import type { MicId } from "../generated/MicId";
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
  /**
   * The Stage browser's own Local mics' readings, under their Local mic ids
   * (`LocalMicsApi.subscribeLocalMicReadings`); they are never relayed.
   */
  localMicReadings?: (
    listener: (localMicId: string, reading: PitchReading) => void,
  ) => () => void;
  /** The Mics taking part in the run. */
  mics: readonly MicKey[];
  /** Plays the tones (`playToneRun` on the Stage's gain chain). */
  playTones: (options: { signal?: AbortSignal }) => Promise<ToneRun>;
  /** Waits `ms`; tests pass one that returns at once. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted when the run ends before the analysis: nothing is reported. */
  signal: AbortSignal;
}

/** The run's Mic a reading came from: a Phone, or a bridge's Local mic. */
function keyOf(from: MicId): MicKey {
  return from.kind === "phone"
    ? { kind: "phone", phoneId: from.phoneId }
    : { kind: "localMic", localMicId: from.localMicId };
}

function sameMic(a: MicKey, b: MicKey): boolean {
  return a.kind === "phone"
    ? b.kind === "phone" && a.phoneId === b.phoneId
    : b.kind === "localMic" && a.localMicId === b.localMicId;
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
  localMicReadings = () => () => {},
  mics,
  playTones,
  wait = waitFor,
  signal,
}: CalibrationTones): Promise<void> {
  const readings = mics.map(() => [] as PitchReading[]);
  const keep = (from: MicKey, reading: PitchReading) => {
    const index = mics.findIndex((mic) => sameMic(mic, from));
    if (index >= 0) readings[index]?.push(reading);
  };
  // Phones and a Mic bridge's Local mics are relayed; the Stage browser's
  // own Local mics come straight from its capture.
  const stopRelayed = store.onPitchReading((from, reading) => {
    keep(keyOf(from), reading);
  });
  const stopLocal = localMicReadings((localMicId, reading) => {
    keep({ kind: "localMic", localMicId }, reading);
  });
  const stop = () => {
    stopRelayed();
    stopLocal();
  };
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
