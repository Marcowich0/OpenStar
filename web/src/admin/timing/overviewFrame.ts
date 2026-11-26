// The Timing editor's overview strip as a draw list (v1 spec #57): the whole
// Song's waveform, one bar per Line (Voice 1 and Voice 2 on separate rows)
// coloured by the Line's share, the detail view's window and the playhead.
// Pure; `editorPainter.ts` draws it.

import type { BeatGrid } from "../../clock/beats";
import type { Matcher } from "../../fit/fit";
import type { PitchTrack } from "../../fit/pitchTrackFile";
import type { ParsedSong } from "../../generated/ParsedSong";
import type { TokenName } from "../../theme/tokens";
import { noteTimes } from "../../timing/timingModel";
import type { LineBarEntry, PlayheadEntry, ShareColour } from "./detailFrame";
import type { EditorView } from "./editorView";

export interface OverviewInput {
  song: ParsedSong;
  grid: BeatGrid;
  track: PitchTrack | null;
  matcher: Matcher | null;
  /** The Song's length in seconds: the strip's full width. */
  duration: number;
  playhead: number;
  /** The detail view's window, outlined on the strip. */
  view: EditorView;
  detailWidth: number;
  width: number;
  height: number;
}

/** The waveform, one column per pixel from x = 0, rising `heights[x]` from `base`. */
export interface OverviewWaveEntry {
  type: "waveform";
  base: number;
  maxHeight: number;
  heights: number[];
  colour: TokenName;
}

/** The detail view's window: an outlined rectangle. */
export interface WindowEntry {
  type: "window";
  x: number;
  y: number;
  width: number;
  height: number;
  colour: TokenName;
  lineWidth: number;
}

export type OverviewEntry =
  OverviewWaveEntry | LineBarEntry | WindowEntry | PlayheadEntry;

export const OVERVIEW = {
  barHeight: 16,
  rowGap: 4,
  waveMargin: 5,
  minBarWidth: 2,
} as const;

/** The Song time under `x` on a strip `width` px wide showing `duration` s. */
export function overviewTimeAt(
  x: number,
  width: number,
  duration: number,
): number {
  return Math.max(0, Math.min(duration, (x / width) * duration));
}

export function overviewFrame(input: OverviewInput): OverviewEntry[] {
  const { song, grid, track, matcher, width, height } = input;
  const duration = input.duration > 0 ? input.duration : 1;
  const x = (seconds: number) => (seconds / duration) * width;
  const list: OverviewEntry[] = [];

  if (track) {
    const n = track.envelope.length;
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, track.envelope[i] ?? 0);
    const maxHeight = height - 2 * OVERVIEW.waveMargin;
    const heights: number[] = [];
    for (let column = 0; column < width; column++) {
      // The loudest frame under the column.
      const from = Math.floor(
        ((column / width) * duration) / track.frameSeconds,
      );
      const to = Math.max(
        from + 1,
        Math.floor((((column + 1) / width) * duration) / track.frameSeconds),
      );
      let v = 0;
      for (let i = from; i < to && i < n; i++)
        v = Math.max(v, track.envelope[i] ?? 0);
      heights.push(max > 0 ? (v / max) * maxHeight : 0);
    }
    list.push({
      type: "waveform",
      base: height - OVERVIEW.waveMargin,
      maxHeight,
      heights,
      colour: "--color-cream-2",
    });
  }

  // One row per Voice, centred in the strip.
  const rows = song.voices.length;
  const block = rows * OVERVIEW.barHeight + (rows - 1) * OVERVIEW.rowGap;
  const firstRow = (height - block) / 2;
  const shares = matcher
    ? matcher.lineShares(
        song.voices.flatMap((voice, v) =>
          voice.lines.flatMap((l, line) =>
            l.notes.map((note) => ({
              voice: v,
              line,
              kind: note.kind,
              start: note.start,
              length: note.length,
              pitch: note.pitch,
            })),
          ),
        ),
        grid,
      )
    : [];
  const shareOf = (voice: number, line: number): ShareColour => {
    if (!matcher) return { type: "pending" };
    const share =
      shares.find((s) => s.voice === voice && s.line === line)?.share ?? null;
    return share === null ? { type: "none" } : { type: "share", share };
  };

  song.voices.forEach((voice, v) => {
    voice.lines.forEach((line, l) => {
      const first = line.notes[0];
      const last = line.notes.at(-1);
      if (!first || !last) return;
      const a = x(noteTimes(grid, first).start);
      const b = x(noteTimes(grid, last).end);
      list.push({
        type: "lineBar",
        voice: v,
        line: l,
        x: a,
        y: firstRow + v * (OVERVIEW.barHeight + OVERVIEW.rowGap),
        width: Math.max(OVERVIEW.minBarWidth, b - a),
        height: OVERVIEW.barHeight,
        colour: shareOf(v, l),
      });
    });
  });

  list.push({
    type: "window",
    x: x(input.view.start),
    y: 2,
    width: x(input.detailWidth / input.view.pixelsPerSecond),
    height: height - 4,
    colour: "--color-ink",
    lineWidth: 2,
  });
  list.push({
    type: "playhead",
    x: x(input.playhead),
    width: 3,
    height,
    colour: "--color-red",
  });
  return list;
}
