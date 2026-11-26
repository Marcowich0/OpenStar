/**
 * Loop a Line (`L`, v1 spec #57, ticket #220): the selected Line or range,
 * or else the Line at the playhead, from 1.5 s before its first Note starts
 * to 0.6 s after its last Note ends, in Song time.
 */

import type { BeatGrid } from "../clock/beats";
import { noteTimes } from "../timing/timingModel";
import type { LineSelection } from "../timing/selection";
import type { SoundingSong } from "./noteScheduler";

export const LOOP = { beforeSeconds: 1.5, afterSeconds: 0.6 } as const;

/** A stretch of Song time, seconds. */
export interface LoopRange {
  start: number;
  end: number;
}

type Line = SoundingSong["voices"][number]["lines"][number];

/** A Line's span: its first Note's start to its last Note's end. */
function lineSpan(grid: BeatGrid, line: Line): LoopRange | null {
  let start = Infinity;
  let end = -Infinity;
  for (const note of line.notes) {
    const times = noteTimes(grid, note);
    start = Math.min(start, times.start);
    end = Math.max(end, times.end);
  }
  return start <= end ? { start, end } : null;
}

function padded(span: LoopRange): LoopRange {
  return {
    start: Math.max(0, round6(span.start - LOOP.beforeSeconds)),
    end: round6(span.end + LOOP.afterSeconds),
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** The range `L` loops; `null` when the Song has no Notes. */
export function loopRange(
  song: SoundingSong,
  grid: BeatGrid,
  selection: LineSelection | null,
  playhead: number,
): LoopRange | null {
  if (selection) {
    const lines = song.voices[selection.voice]?.lines ?? [];
    const first = lines[selection.first];
    const last = lines[selection.last];
    const from = first && lineSpan(grid, first);
    const to = last && lineSpan(grid, last);
    if (from && to) return padded({ start: from.start, end: to.end });
  }
  const spans: LoopRange[] = [];
  for (const voice of song.voices)
    for (const line of voice.lines) {
      const span = lineSpan(grid, line);
      if (span) spans.push(span);
    }
  spans.sort((a, b) => a.start - b.start);
  const at =
    spans.find((s) => s.start <= playhead && playhead < s.end) ??
    spans.find((s) => s.start > playhead) ??
    spans.at(-1);
  return at ? padded(at) : null;
}

/** Where to seek to go round the loop at Song time `songTime`; `null`: play on. */
export function loopSeek(songTime: number, range: LoopRange): number | null {
  return songTime >= range.end ? range.start : null;
}
