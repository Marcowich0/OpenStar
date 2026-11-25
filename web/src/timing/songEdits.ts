/**
 * Whole-Song gestures of the Timing editor: each turns the model and the
 * gesture's inputs into one edit (timing operations plus a description), or
 * `null` when it would change nothing or is refused. Only `#GAP` and `#BPM`
 * change continuously; no gesture moves a Note off its Beat or doubles
 * `#BPM`.
 */

import { beatStart } from "../clock/beats";
import {
  currentTiming,
  type TimingEdit,
  type TimingModel,
} from "./timingModel";

/** `x` rounded to two decimals, as `#BPM` and `#VIDEOGAP` are written. */
export const round2 = (x: number) => Math.round(x * 100) / 100;

/** An edit setting `#GAP` to `gapMs` (whole milliseconds). */
function setGap(
  model: TimingModel,
  gapMs: number,
  kind: "moveSong" | "nudgeSong" | "typeGap",
): TimingEdit | null {
  const fromGapMs = currentTiming(model).gapMs;
  if (gapMs === fromGapMs) return null;
  return {
    operations: [{ op: "setGap", seconds: gapMs / 1000 }],
    description: { kind, fromGapMs, toGapMs: gapMs },
    ...(kind === "nudgeSong" && { merge: { kind, target: "song" } }),
  };
}

/** Drag on empty space: `#GAP` changes by the dragged time (seconds). */
export function moveSong(
  model: TimingModel,
  draggedSeconds: number,
): TimingEdit | null {
  const { gapMs } = currentTiming(model);
  return setGap(model, Math.round(gapMs + draggedSeconds * 1000), "moveSong");
}

/** `,` (direction −1) and `.` (+1): ±10 ms, with Shift ±100 ms. */
export function nudgeSong(
  model: TimingModel,
  { direction, shift }: { direction: -1 | 1; shift: boolean },
): TimingEdit | null {
  const { gapMs } = currentTiming(model);
  const step = shift ? 100 : 10;
  return setGap(model, Math.round(gapMs + direction * step), "nudgeSong");
}

/** A typed `#GAP` in milliseconds, rounded to whole milliseconds. */
export function typeGap(model: TimingModel, gapMs: number): TimingEdit | null {
  if (!Number.isFinite(gapMs)) return null;
  return setGap(model, Math.round(gapMs), "typeGap");
}

/** The lowest `#BPM` the file can hold: the parser needs a real rate ≥ 1. */
const MIN_FILE_BPM = 0.25;

/** A typed `#BPM`, rounded to two decimals. */
export function typeBpm(model: TimingModel, bpm: number): TimingEdit | null {
  const toBpm = round2(bpm);
  const fromBpm = currentTiming(model).bpm;
  if (!Number.isFinite(toBpm) || toBpm < MIN_FILE_BPM || toBpm === fromBpm) {
    return null;
  }
  return {
    operations: [{ op: "setBpm", beatsPerMinute: toBpm * 4 }],
    description: { kind: "typeBpm", fromBpm, toBpm },
  };
}

/** A typed `#VIDEOGAP` in seconds, rounded to two decimals. */
export function typeVideoGap(
  model: TimingModel,
  seconds: number,
): TimingEdit | null {
  const toSeconds = round2(seconds);
  const fromSeconds = currentTiming(model).videoGapSeconds;
  if (!Number.isFinite(toSeconds) || toSeconds === fromSeconds) return null;
  return {
    operations: [{ op: "setVideoGap", seconds: toSeconds }],
    description: { kind: "typeVideoGap", fromSeconds, toSeconds },
  };
}

/** Which Line is pinned: indices into `voices` and that Voice's `lines`. */
export interface LineIndex {
  readonly voice: number;
  readonly line: number;
}

/** A stretch needs the grabbed Beat at least this far from the pinned Note. */
export const PIN_MIN_BEATS = 32;
/** A stretch or tempo change outside this `#BPM` range is ignored. */
export const MIN_BPM = 20;
export const MAX_BPM = 2000;

/** The (fractional) Beat at Song time `t`. */
function beatAtTime(model: TimingModel, t: number): number {
  const { grid } = currentTiming(model);
  return ((t - grid.gapSeconds) * grid.beatsPerMinute) / 60;
}

/**
 * Sets `#BPM` to `bpm` (two decimals) and solves `#GAP` so that Beat `beat`
 * falls at Song time `t`. `#GAP` is solved with the seconds per Beat of the
 * rounded `#BPM`, so Beat `beat` keeps its time to within half a millisecond.
 */
function setTempoAround(
  model: TimingModel,
  bpm: number,
  beat: number,
  t: number,
  kind: "stretchAroundPin" | "tempoAroundPlayhead",
): TimingEdit | null {
  const toBpm = round2(bpm);
  if (!Number.isFinite(toBpm) || toBpm < MIN_BPM || toBpm > MAX_BPM) {
    return null;
  }
  const secondsPerBeat = 15 / toBpm;
  const toGapMs = Math.round((t - beat * secondsPerBeat) * 1000);
  const { gapMs: fromGapMs, bpm: fromBpm } = currentTiming(model);
  if (toBpm === fromBpm && toGapMs === fromGapMs) return null;
  return {
    operations: [
      { op: "setGap", seconds: toGapMs / 1000 },
      { op: "setBpm", beatsPerMinute: toBpm * 4 },
    ],
    description: { kind, fromGapMs, toGapMs, fromBpm, toBpm },
    ...(kind === "tempoAroundPlayhead" && { merge: { kind, target: "song" } }),
  };
}

/**
 * Drag on empty space with a pinned Line: solves `#GAP` and `#BPM` so the
 * pinned Line's first Note keeps its time (b₁, t₁) and the Beat grabbed at
 * `grabSeconds` (b₂) follows the pointer to `pointerSeconds` (t₂):
 * `s = (t₂ − t₁) / (b₂ − b₁)`, `BPM = round₂(60 / (4 × s))`. A result outside
 * 20–2000 BPM gives `null`. A grab closer than 32 Beats to the pinned Note
 * moves the whole Song instead.
 */
export function stretchAroundPin(
  model: TimingModel,
  {
    pin,
    grabSeconds,
    pointerSeconds,
  }: { pin: LineIndex; grabSeconds: number; pointerSeconds: number },
): TimingEdit | null {
  const timing = currentTiming(model);
  const pinned = timing.song.voices[pin.voice]?.lines[pin.line]?.notes[0];
  const b2 = beatAtTime(model, grabSeconds);
  if (!pinned || Math.abs(b2 - pinned.start) < PIN_MIN_BEATS) {
    return moveSong(model, pointerSeconds - grabSeconds);
  }
  const b1 = pinned.start;
  const t1 = beatStart(timing.grid, b1);
  const s = (pointerSeconds - t1) / (b2 - b1);
  return setTempoAround(model, 60 / (4 * s), b1, t1, "stretchAroundPin");
}

/**
 * `[` (direction −1) and `]` (+1): `#BPM` by ∓0.05 (with Shift ∓0.5), and
 * `#GAP` re-solved so the Beat under the playhead stays at the playhead.
 */
export function tempoAroundPlayhead(
  model: TimingModel,
  {
    direction,
    shift,
    playheadSeconds,
  }: { direction: -1 | 1; shift: boolean; playheadSeconds: number },
): TimingEdit | null {
  const { bpm } = currentTiming(model);
  const step = shift ? 0.5 : 0.05;
  const beat = beatAtTime(model, playheadSeconds);
  return setTempoAround(
    model,
    bpm + direction * step,
    beat,
    playheadSeconds,
    "tempoAroundPlayhead",
  );
}
