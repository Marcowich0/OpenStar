/**
 * The pitch trace held to the playhead (#50): one lane's pitch line and head
 * ball, computed inside the pure `frame()` from the Player's ring buffer.
 *
 * - Real readings are drawn at their Song times, up to the playhead. A reading
 *   still ahead of the playhead is not drawn yet.
 * - From the newest drawn reading the line continues flat at its pitch up to
 *   the playhead, where the head ball sits. Readings replace that guess as they
 *   arrive, simply because the next frame draws them instead.
 * - Nothing is guessed after an unvoiced reading (the scorer's `isVoiced`), and
 *   the guess stops once the playhead is `TRACE_HOLD_SECONDS` past the newest
 *   reading, so a lost Phone's line just ends. Unvoiced readings break the line.
 * - Every point is folded by whole octaves to the Note under it, or to the
 *   nearest Note in time where none is under it, with the scorer's own fold.
 * - A point is a hit exactly when the scorer's `readingHits` passes for it;
 *   a guessed point is tested at its held pitch.
 *
 * Drawing never feeds scoring: nothing here writes the buffer or calls the
 * scorer's Beat judgement. Reading the buffer allocates nothing beyond the
 * draw list's own entries: the visitor is one module function and the per-lane
 * context lives in module scratch variables (the frame is single-threaded and
 * never re-entered).
 */

import { beatAt, beatStart, type BeatGrid } from "../../clock/beats";
import type { Difficulty } from "../../generated/Difficulty";
import type { Note } from "../../generated/Note";
import type { PitchBuffer, PitchReadingVisitor } from "../../pitch/pitchBuffer";
import { isVoiced } from "../../scoring/beatValues";
import { foldedCents, readingHits } from "../../scoring/scorer";
import type { PaletteKey, TokenName } from "../../theme/tokens";
import type { DrawList } from "./frame";

/**
 * How long the line is held flat past the newest reading before it ends, in
 * seconds of Song time. The one place this number lives; tune it here.
 */
export const TRACE_HOLD_SECONDS = 0.6;

/** What a lane's trace reads, besides the frame's Song time. */
export interface LaneTrace {
  /** The Player's ring buffer, readings placed on Song time (#127). */
  readings: PitchBuffer;
  /** The Mic's effective Mic threshold, fixed from Start (dBFS). */
  micThresholdDbfs: number;
  /** The Player's Difficulty, for the hit test. */
  difficulty: Difficulty;
  /**
   * Song time the Mic was lost, `null` while it is not. Read every frame, so
   * whoever detects the loss (and the return) sets it in place.
   */
  lostAt: number | null;
}

/** One point of a pitch line, in the reference frame. */
export interface TracePoint {
  songTime: number;
  /** The drawn pitch: folded to the Note's octave, in Note pitch units (C4 = 0). */
  pitch: number;
  x: number;
  y: number;
  /** The stretch from the previous point to this one is a hit. */
  hit: boolean;
  /** A held point between the newest reading and the playhead. */
  guessed: boolean;
}

/** One unbroken run of a lane's pitch line, oldest point first. */
export interface PitchLineEntry {
  type: "pitchLine";
  lane: number;
  points: TracePoint[];
  /** Hit stretches: the Party colour over a wider ink edge, round caps and joins. */
  hit: {
    colour: PaletteKey;
    width: number;
    edge: TokenName;
    edgeWidth: number;
  };
  /** Miss stretches: thin, no edge. */
  miss: { colour: TokenName; alpha: number; width: number };
}

/** The head ball: on the playhead at the current pitch, only while voiced. */
export interface HeadBallEntry {
  type: "headBall";
  lane: number;
  x: number;
  y: number;
  pitch: number;
  radius: number;
  colour: PaletteKey;
  rim: TokenName;
  rimWidth: number;
  /**
   * The bounce: the ball's horizontal (`x`) and vertical (`y`) scale. Wider
   * and flatter by up to `HEAD_BALL_SQUASH`, with `x × y = 1`, so it keeps
   * its area. The painter scales the disc and its rim about its centre.
   */
  squash: { x: number; y: number };
  /**
   * It is hitting a golden Note (a golden or golden Rap Note), so it
   * sparkles (#216). Absent: not golden (a drawing with no Notes of its own).
   */
  golden?: boolean;
}

/** The head ball's bounce at its widest: 14 % (#55). */
export const HEAD_BALL_SQUASH = 0.14;
/** The bounce's speed, radians of Song time per second, as in the prototype. */
const BOUNCE_RATE = 9;

/**
 * The head ball's squash at Song time `songTime` in lane `lane` (lanes bounce
 * out of step). On Song time, so a paused or frozen frame holds still.
 */
export function headBallSquash(
  songTime: number,
  lane: number,
): { x: number; y: number } {
  const x =
    1 + HEAD_BALL_SQUASH * Math.abs(Math.sin(songTime * BOUNCE_RATE + lane));
  return { x, y: 1 / x };
}

/**
 * For each Beat, the Note under it (first in Note order) and the Note a point
 * there is folded to (the one under it, else the nearest in time). Built once
 * per Voice, so a frame looks Notes up without searching.
 */
export interface NoteIndex {
  firstBeat: number;
  /** Index into the Voice's Notes, −1 where no Note is under the Beat. */
  under: Int32Array;
  /** Index of the Note to fold to; −1 only for a Voice without Notes. */
  fold: Int32Array;
  /** Fold Note for Beats before `firstBeat`, and after the table. */
  before: number;
  after: number;
}

/** Beats a Note covers: zero-length Notes count as one Beat, as the scorer does. */
function span(note: Note): number {
  return Math.max(1, note.length);
}

export function noteIndex(notes: readonly Note[]): NoteIndex {
  if (notes.length === 0) {
    const empty = new Int32Array(0);
    return { firstBeat: 0, under: empty, fold: empty, before: -1, after: -1 };
  }
  let first = Infinity;
  let end = -Infinity;
  let before = 0;
  let after = 0;
  notes.forEach((n, i) => {
    if (n.start < first) {
      first = n.start;
      before = i;
    }
    if (n.start + span(n) > end) {
      end = n.start + span(n);
      after = i;
    }
  });
  const size = end - first;
  const under = new Int32Array(size).fill(-1);
  const distance = new Float64Array(size).fill(Infinity);
  const fold = new Int32Array(size).fill(-1);
  notes.forEach((n, i) => {
    for (let b = 0; b < size; b++) {
      const beat = first + b;
      const last = n.start + span(n) - 1;
      const d = beat < n.start ? n.start - beat : beat > last ? beat - last : 0;
      if (d === 0 && under[b] === -1) under[b] = i;
      if (d < (distance[b] ?? Infinity)) {
        distance[b] = d;
        fold[b] = i;
      }
    }
  });
  for (let b = 0; b < size; b++) {
    const u = under[b] ?? -1;
    if (u >= 0) fold[b] = u;
  }
  return { firstBeat: first, under, fold, before, after };
}

/** The lane geometry and styles the trace needs, from `frame()`. */
export interface TraceLane {
  lane: number;
  colour: PaletteKey;
  playheadX: number;
  pixelsPerBeat: number;
  /** Left edge of the Notes area. */
  notesX: number;
  /** Lane height, for the narrow-lane sizes. */
  height: number;
  /** Maps a Note pitch to y. */
  low: number;
  range: number;
  inner: number;
  bottom: number;
}

const EDGE: TokenName = "--color-ink";
/** Edge is this much wider than the hit stroke. */
const EDGE_EXTRA = 5;
const MISS_WIDE = {
  colour: "--color-ink",
  alpha: 0.22,
  width: 12 * 0.55,
} as const;
const MISS_NARROW = {
  colour: "--color-ink",
  alpha: 0.22,
  width: 9 * 0.55,
} as const;
/** Lanes under this height get the narrow line and the small ball. */
const NARROW_LANE = 130;

// Module scratch: the lane being traced. Set before each `forEachFrom`, so the
// one visitor below needs no closure.
let grid: BeatGrid = { gapSeconds: 0, beatsPerMinute: 1 };
let notes: readonly Note[] = [];
let index: NoteIndex = noteIndex([]);
let geometry: TraceLane | null = null;
let threshold = 0;
let difficulty: Difficulty = "medium";
let lostAt: number | null = null;
let playhead = 0;
let out: DrawList = [];
let run: TracePoint[] | null = null;
let headTime = -Infinity;
let headVoiced = false;
let headPitch = 0;
let headClarity = 0;
let headLoudness = 0;
/** The newest point hit a golden Note. */
let lastGolden = false;
/** The reading the hit test sees; reused, so testing allocates nothing. */
const reading = { pitch: null as number | null, clarity: 0, loudness: 0 };

function noteAt(table: Int32Array, beat: number, outside: number): number {
  const i = beat - index.firstBeat;
  if (i < 0) return outside === -1 ? -1 : index.before;
  if (i >= table.length) return outside === -1 ? -1 : index.after;
  return table[i] ?? -1;
}

function endRun() {
  run = null;
}

function resetHead() {
  run = null;
  lastGolden = false;
  headTime = -Infinity;
  headVoiced = false;
}

/** Adds a point for `reading` (its current values) in Beat `beat` at `songTime`. */
function addPoint(songTime: number, beat: number, guessed: boolean) {
  const g = geometry;
  const raw = reading.pitch;
  if (!g || raw === null) return;
  const foldTo = notes[noteAt(index.fold, beat, 0)];
  const pitch = foldTo
    ? foldTo.pitch + foldedCents(raw, foldTo.pitch) / 100
    : raw - 60;
  const under = notes[noteAt(index.under, beat, -1)];
  const hit = under
    ? readingHits(reading, threshold, under, difficulty)
    : false;
  lastGolden = hit && (under?.kind === "golden" || under?.kind === "goldenRap");
  const point: TracePoint = {
    songTime,
    pitch,
    x:
      g.playheadX +
      ((songTime - playhead) * grid.beatsPerMinute * g.pixelsPerBeat) / 60,
    y: g.bottom - ((pitch - g.low) / g.range) * g.inner,
    hit,
    guessed,
  };
  if (!run) {
    run = [];
    const narrow = g.height < NARROW_LANE;
    const width = narrow ? 9 : 12;
    out.push({
      type: "pitchLine",
      lane: g.lane,
      points: run,
      hit: {
        colour: g.colour,
        width,
        edge: EDGE,
        edgeWidth: width + EDGE_EXTRA,
      },
      miss: narrow ? MISS_NARROW : MISS_WIDE,
    } satisfies PitchLineEntry);
  }
  run.push(point);
}

const visit: PitchReadingVisitor = (songTime, pitch, clarity, loudness) => {
  if (songTime > playhead) return; // not reached by the playhead yet
  if (lostAt !== null && songTime >= lostAt) return;
  reading.pitch = pitch;
  reading.clarity = clarity;
  reading.loudness = loudness;
  if (!isVoiced(reading, threshold)) {
    endRun();
    headVoiced = false;
    headTime = songTime;
    return;
  }
  if (songTime > headTime + TRACE_HOLD_SECONDS) endRun();
  addPoint(songTime, beatAt(grid, songTime), false);
  headVoiced = true;
  headTime = songTime;
  headPitch = pitch ?? 0;
  headClarity = clarity;
  headLoudness = loudness;
};

/**
 * Appends lane `g`'s pitch line runs and head ball to `list`, for the drawing
 * time `songTime` (the playhead).
 */
export function traceLane(
  list: DrawList,
  trace: LaneTrace,
  g: TraceLane,
  songGrid: BeatGrid,
  voiceNotes: readonly Note[],
  voiceIndex: NoteIndex,
  songTime: number,
): void {
  grid = songGrid;
  notes = voiceNotes;
  index = voiceIndex;
  geometry = g;
  threshold = trace.micThresholdDbfs;
  difficulty = trace.difficulty;
  lostAt = trace.lostAt;
  playhead = songTime;
  out = list;
  // Reset in a function: the visitor changes these, which inline assignments
  // here would hide from TypeScript's narrowing.
  resetHead();

  const secondsPerPixel = 60 / (songGrid.beatsPerMinute * g.pixelsPerBeat);
  const from = Math.min(
    songTime - (g.playheadX - g.notesX) * secondsPerPixel,
    songTime - TRACE_HOLD_SECONDS,
  );
  trace.readings.forEachFrom(from, visit);

  const lost = lostAt !== null && lostAt <= songTime;
  // Compared as a sum, so a playhead exactly 600 ms on stops the guess.
  if (headVoiced && !lost && songTime < headTime + TRACE_HOLD_SECONDS) {
    reading.pitch = headPitch;
    reading.clarity = headClarity;
    reading.loudness = headLoudness;
    if (songTime > headTime) {
      const lastBeat = beatAt(songGrid, songTime);
      for (let b = beatAt(songGrid, headTime) + 1; b <= lastBeat; b++) {
        const boundary = beatStart(songGrid, b);
        addPoint(boundary, b - 1, true);
        addPoint(boundary, b, true);
      }
      addPoint(songTime, lastBeat, true);
    }
    const current = run?.[run.length - 1];
    if (current) {
      const narrow = g.height < NARROW_LANE;
      list.push({
        type: "headBall",
        lane: g.lane,
        x: g.playheadX,
        y: current.y,
        pitch: current.pitch,
        radius: narrow ? 11 : 14,
        colour: g.colour,
        rim: "--color-white",
        rimWidth: 3,
        squash: headBallSquash(songTime, g.lane),
        golden: lastGolden,
      } satisfies HeadBallEntry);
    }
  }
  out = [];
  run = null;
  geometry = null;
}
