// The Timing editor's detail view as a draw list (v1 spec #57): pure, from the
// edited Song, its Pitch track (or `null` while it is pending), the playhead
// and the view's window on Song time. The painter (`editorPainter.ts`) only
// draws what this lists; layout and styling numbers live here. Colours are
// token names, never colour values.
//
// Layout and look follow the timing-editor prototype (variant A): a ruler on
// top, the Notes as pills on a pitch grid against Song time, the heard pitch
// as dots folded into the Notes' octave range, the waveform band at the
// bottom, and the playhead.

import type { BeatGrid } from "../../clock/beats";
import {
  counts,
  FRAME_SECONDS,
  type FitNote,
  type Matcher,
} from "../../fit/fit";
import type { PitchTrack } from "../../fit/pitchTrackFile";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import { t } from "../../i18n/t";
import type { TokenName } from "../../theme/tokens";
import type { LineSelection } from "../../timing/selection";
import type { LineIndex } from "../../timing/songEdits";
import { noteTimes } from "../../timing/timingModel";
import { timeAtX, xAtTime, type EditorView } from "./editorView";

export interface DetailInput {
  /** The Song with every edit applied (`currentTiming(model).song`). */
  song: ParsedSong;
  grid: BeatGrid;
  /** `null` while the Pitch track is pending (or could not be had). */
  track: PitchTrack | null;
  /** The match measure on `track`; `null` with it. */
  matcher: Matcher | null;
  /** Song time of the playhead, in seconds. */
  playhead: number;
  view: EditorView;
  /** The canvas's size in CSS pixels. */
  width: number;
  height: number;
  /** The selected Lines, tinted, with the ◀▶ handle at their end. */
  selection?: LineSelection | null;
  /** The pinned Line, tinted and marked. */
  pin?: LineIndex | null;
}

/** How a Line's share colours its bar: a share (red to green), pending, or none counts. */
export type ShareColour =
  { type: "share"; share: number } | { type: "pending" } | { type: "none" };

export interface RulerEntry {
  type: "ruler";
  height: number;
  colour: TokenName;
  ticks: { x: number; height: number }[];
  labels: { x: number; text: string }[];
  ink: TokenName;
}

/** The C rows of the pitch grid: bands `height` tall centred on `ys`. */
export interface RowsEntry {
  type: "rows";
  ys: number[];
  height: number;
  colour: TokenName;
}

/** The waveform band: one column per pixel from x = 0, `heights[x]` above and below `mid`. */
export interface WaveformEntry {
  type: "waveform";
  mid: number;
  halfHeight: number;
  heights: number[];
  colour: TokenName;
}

/** The faint band behind a Line's Notes (tinted when selected or pinned). */
export interface LineBandEntry {
  type: "lineBand";
  voice: number;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  colour: TokenName;
  alpha: number;
}

/** The thin bar over a Line, coloured by its share. */
export interface LineBarEntry {
  type: "lineBar";
  voice: number;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  colour: ShareColour;
}

/** The heard pitch: a square dot `size` px wide centred on each (x, y) pair. */
export interface DotsEntry {
  type: "dots";
  points: number[];
  size: number;
  colour: TokenName;
  alpha: number;
}

export interface PillEntry {
  type: "pill";
  kind: NoteKind;
  voice: number;
  line: number;
  note: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `null`: hollow (Freestyle). */
  fill: "white" | "golden" | null;
  /** Rap and Golden rap notes have a dashed outline. */
  dashed: boolean;
  outline: TokenName;
  outlineWidth: number;
  /** The green fill from the left; `null` for a Note that never counts or while pending. */
  match: { share: number; width: number } | null;
  matchColour: TokenName;
  lyric: { text: string; x: number; y: number; italic: boolean };
}

/** The pinned Line's mark: a pin head at (x, y) on a stem down to `y + stem`. */
export interface PinEntry {
  type: "pin";
  x: number;
  y: number;
  radius: number;
  stem: number;
  colour: TokenName;
}

/** The ◀▶ handle at the end of the selection: drag it to stretch. */
export interface HandleEntry {
  type: "handle";
  x: number;
  y: number;
  width: number;
  height: number;
  colour: TokenName;
  ink: TokenName;
  text: string;
}

export interface PlayheadEntry {
  type: "playhead";
  x: number;
  width: number;
  height: number;
  colour: TokenName;
}

export type DetailEntry =
  | RulerEntry
  | RowsEntry
  | WaveformEntry
  | LineBandEntry
  | LineBarEntry
  | DotsEntry
  | PillEntry
  | PinEntry
  | HandleEntry
  | PlayheadEntry;

/** The detail view's layout, in CSS pixels. */
export const DETAIL = {
  ruler: 24,
  /** The Notes area starts this far below the ruler … */
  notesTop: 22,
  /** … and ends this far above the waveform band. */
  notesBottom: 18,
  wave: 56,
  /** Semitones shown beyond the lowest and highest Note. */
  pitchMargin: 2,
  pillShare: 0.84,
  minPillHeight: 8,
  minPillWidth: 4,
  outlineWidth: 2.5,
  lyricGap: 13,
  dotSize: 3,
  playheadWidth: 3,
  handleWidth: 16,
  handleHeight: 18,
  /** The handle sits this far right of the selection's end and below the ruler. */
  handleGap: 2,
  pinRadius: 5,
  /** A Note's right end is its last this many px (on pills wider than `edgeMinWidth`). */
  edge: 6,
  edgeMinWidth: 10,
  /** A press this close to a pill is on it. */
  hitSlack: 3,
  /** Off-screen slack, so a pill or Line partly in view is still drawn. */
  slack: 20,
} as const;

const RAP: ReadonlySet<NoteKind> = new Set(["rap", "goldenRap"]);
const ITALIC: ReadonlySet<NoteKind> = new Set([
  "rap",
  "goldenRap",
  "freestyle",
]);

/** The pitch rows the Notes span (Rap notes, drawn at mid-height, don't count). */
function pitchRange(song: ParsedSong): { low: number; high: number } {
  let low = Infinity;
  let high = -Infinity;
  for (const v of song.voices)
    for (const l of v.lines)
      for (const n of l.notes) {
        if (RAP.has(n.kind)) continue;
        low = Math.min(low, n.pitch);
        high = Math.max(high, n.pitch);
      }
  if (low > high) {
    low = 0;
    high = 0;
  }
  return { low: low - DETAIL.pitchMargin, high: high + DETAIL.pitchMargin };
}

/** Ticks every `tick` s and a label every `label` s, at least this many px apart. */
const TICK_STEPS = [1, 5, 10, 30, 60];
const LABEL_STEPS = [5, 10, 30, 60, 120, 300];
const MIN_TICK_PX = 8;
const MIN_LABEL_PX = 50;

function ruler(view: EditorView, width: number): RulerEntry {
  const pps = view.pixelsPerSecond;
  const tick = TICK_STEPS.find((s) => s * pps >= MIN_TICK_PX) ?? 60;
  const label =
    LABEL_STEPS.find((s) => s % tick === 0 && s * pps >= MIN_LABEL_PX) ?? 600;
  const end = timeAtX(view, width);
  const ticks: RulerEntry["ticks"] = [];
  const labels: RulerEntry["labels"] = [];
  for (let s = Math.ceil(view.start / tick) * tick; s < end; s += tick) {
    const x = xAtTime(view, s);
    const labelled = s % label === 0;
    ticks.push({ x, height: labelled ? 12 : 6 });
    if (labelled && s >= 0) labels.push({ x, text: clockText(s) });
  }
  return {
    type: "ruler",
    height: DETAIL.ruler,
    colour: "--color-cream",
    ticks,
    labels,
    ink: "--color-ink",
  };
}

/** `m:ss` for a whole number of seconds. */
export function clockText(seconds: number): string {
  const whole = Math.floor(seconds);
  return t("timing.view.clock", {
    minutes: String(Math.floor(whole / 60)),
    seconds: String(whole % 60).padStart(2, "0"),
  });
}

function loudest(envelope: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < envelope.length; i++)
    max = Math.max(max, envelope[i] ?? 0);
  return max;
}

export function detailFrame(input: DetailInput): DetailEntry[] {
  const { song, grid, track, matcher, view, width, height } = input;
  const list: DetailEntry[] = [];
  const top = DETAIL.ruler + DETAIL.notesTop;
  const bottom = height - DETAIL.wave - DETAIL.notesBottom;
  const { low, high } = pitchRange(song);
  const rowHeight = (bottom - top) / (high - low + 1);
  const yOf = (pitch: number) => top + (high - pitch) * rowHeight;
  const x = (seconds: number) => xAtTime(view, seconds);
  const visible = (a: number, b: number) =>
    b >= -DETAIL.slack && a <= width + DETAIL.slack;

  // The C rows of the pitch grid.
  const cs: number[] = [];
  for (let p = Math.ceil(low); p <= high; p++)
    if (((p % 12) + 12) % 12 === 0) cs.push(yOf(p));
  list.push({
    type: "rows",
    ys: cs,
    height: rowHeight,
    colour: "--color-cream",
  });

  list.push(ruler(view, width));

  if (track) {
    const halfHeight = DETAIL.wave / 2;
    const max = loudest(track.envelope) || 1;
    const heights: number[] = [];
    for (let column = 0; column < width; column++) {
      const i = Math.floor(timeAtX(view, column) / track.frameSeconds);
      const v = i >= 0 && i < track.envelope.length ? track.envelope[i] : 0;
      heights.push(((v ?? 0) / max) * halfHeight);
    }
    list.push({
      type: "waveform",
      mid: height - halfHeight - 4,
      halfHeight,
      heights,
      colour: "--color-blob-blue",
    });
  }

  // The Lines: a faint band behind each, and a bar coloured by its share.
  const { selection, pin } = input;
  const marks: (PinEntry | HandleEntry)[] = [];
  song.voices.forEach((voice, v) => {
    voice.lines.forEach((line, l) => {
      const first = line.notes[0];
      const last = line.notes.at(-1);
      if (!first || !last) return;
      const a = x(noteTimes(grid, first).start);
      const b = x(noteTimes(grid, last).end);
      if (!visible(a, b)) return;
      const selected =
        selection?.voice === v && l >= selection.first && l <= selection.last;
      const pinned = pin?.voice === v && pin.line === l;
      list.push({
        type: "lineBand",
        voice: v,
        line: l,
        x: a - 4,
        y: DETAIL.ruler + 4,
        width: b - a + 8,
        height: bottom - DETAIL.ruler + 8,
        ...(selected
          ? { colour: "--color-blue", alpha: 0.14 }
          : pinned
            ? { colour: "--color-purple", alpha: 0.12 }
            : { colour: "--color-ink", alpha: 0.035 }),
      });
      if (pinned)
        marks.push({
          type: "pin",
          x: a,
          y: DETAIL.ruler + 26,
          radius: DETAIL.pinRadius,
          stem: 12,
          colour: "--color-purple",
        });
      if (selected && l === selection.last)
        marks.push({
          type: "handle",
          x: b + DETAIL.handleGap,
          y: DETAIL.ruler + DETAIL.handleGap,
          width: DETAIL.handleWidth,
          height: DETAIL.handleHeight,
          colour: "--color-blue",
          ink: "--color-white",
          text: "◀▶",
        });
      const share = matcher
        ? matcher.share(fitNotes(line.notes, v, l), grid)
        : null;
      list.push({
        type: "lineBar",
        voice: v,
        line: l,
        x: a,
        y: DETAIL.ruler + 6,
        width: Math.max(4, b - a),
        height: 8,
        colour: !matcher
          ? { type: "pending" }
          : share === null
            ? { type: "none" }
            : { type: "share", share },
      });
    });
  });

  if (track) {
    const first = Math.max(0, Math.floor(view.start / FRAME_SECONDS));
    const last = Math.min(
      track.pitch.length,
      Math.ceil(timeAtX(view, width) / FRAME_SECONDS),
    );
    const points: number[] = [];
    for (let i = first; i < last; i++) {
      const hz = track.pitch[i] ?? 0;
      if (!(hz > 0)) continue;
      points.push(
        x(i * FRAME_SECONDS),
        yOf(foldIntoRange(12 * Math.log2(hz / 440) + 9, low, high)),
      );
    }
    list.push({
      type: "dots",
      points,
      size: DETAIL.dotSize,
      colour: "--color-ink",
      alpha: 0.55,
    });
  }

  const pillHeight = Math.max(
    DETAIL.minPillHeight,
    rowHeight * DETAIL.pillShare,
  );
  song.voices.forEach((voice, v) => {
    voice.lines.forEach((line, l) => {
      line.notes.forEach((note, n) => {
        const times = noteTimes(grid, note);
        const a = x(times.start);
        const b = x(times.end);
        if (!visible(a, b)) return;
        const centre = RAP.has(note.kind)
          ? yOf((low + high) / 2)
          : yOf(note.pitch);
        const pillWidth = Math.max(DETAIL.minPillWidth, b - a);
        const share =
          matcher && counts(note.kind)
            ? matcher.noteShare(fitNote(note, v, l), grid)
            : null;
        const y = centre - pillHeight / 2;
        list.push({
          type: "pill",
          kind: note.kind,
          voice: v,
          line: l,
          note: n,
          x: a,
          y,
          width: pillWidth,
          height: pillHeight,
          fill:
            note.kind === "freestyle"
              ? null
              : note.kind === "golden" || note.kind === "goldenRap"
                ? "golden"
                : "white",
          dashed: RAP.has(note.kind),
          outline: "--color-ink",
          outlineWidth: DETAIL.outlineWidth,
          match: share === null ? null : { share, width: pillWidth * share },
          matchColour: "--color-green",
          lyric: {
            text: note.text.trim(),
            x: a,
            y: y + pillHeight + DETAIL.lyricGap,
            italic: ITALIC.has(note.kind),
          },
        });
      });
    });
  });

  list.push(...marks);
  list.push({
    type: "playhead",
    x: x(input.playhead),
    width: DETAIL.playheadWidth,
    height,
    colour: "--color-red",
  });
  return list;
}

/** What a press on the detail view at (x, y) is on. */
export type DetailHit =
  | { kind: "ruler" }
  | { kind: "handle" }
  | { kind: "note"; voice: number; line: number; note: number; edge: boolean }
  | { kind: "line"; voice: number; line: number }
  | { kind: "empty" };

/**
 * What the pointer at (x, y) is on, from the same layout as the draw list:
 * the ruler, the ◀▶ handle, a Note (its right end in the last 6 px), a Line
 * (by time alone, below the ruler), or empty space. Needs no Pitch track.
 */
export function hitDetail(input: DetailInput, x: number, y: number): DetailHit {
  if (y < DETAIL.ruler) return { kind: "ruler" };
  // Everything up to x is listed, whatever the canvas measures (0 in tests).
  const list = detailFrame({
    ...input,
    track: null,
    matcher: null,
    width: Math.max(input.width, x + 1),
  });
  const inside = (
    e: { x: number; y: number; width: number; height: number },
    slack: number,
  ) =>
    x >= e.x - slack &&
    x <= e.x + e.width + slack &&
    y >= e.y - slack &&
    y <= e.y + e.height + slack;
  for (const e of list)
    if (e.type === "handle" && inside(e, 0)) return { kind: "handle" };
  // The last pill drawn is on top.
  for (const e of list.toReversed()) {
    if (e.type !== "pill" || !inside(e, DETAIL.hitSlack)) continue;
    const edge =
      e.width > DETAIL.edgeMinWidth && x > e.x + e.width - DETAIL.edge;
    return { kind: "note", voice: e.voice, line: e.line, note: e.note, edge };
  }
  for (const e of list)
    if (e.type === "lineBand" && x >= e.x && x <= e.x + e.width)
      return { kind: "line", voice: e.voice, line: e.line };
  return { kind: "empty" };
}

/** Octaves a heard pitch may be moved by to reach the Notes' range. */
const MAX_FOLD_OCTAVES = 4;

/**
 * A heard pitch (semitones from C4) moved by whole octaves to where it is
 * nearest the range [low, high]: kept as it is when inside, and the smaller
 * move on a tie.
 */
export function foldIntoRange(m: number, low: number, high: number): number {
  const distance = (v: number) => Math.max(0, low - v, v - high);
  let best = m;
  for (let k = 1; k <= MAX_FOLD_OCTAVES; k++) {
    for (const v of [m - 12 * k, m + 12 * k]) {
      if (distance(v) < distance(best)) best = v;
    }
  }
  return best;
}

function fitNote(
  note: ParsedSong["voices"][number]["lines"][number]["notes"][number],
  voice: number,
  line: number,
): FitNote {
  return {
    voice,
    line,
    kind: note.kind,
    start: note.start,
    length: note.length,
    pitch: note.pitch,
  };
}

function fitNotes(
  notes: ParsedSong["voices"][number]["lines"][number]["notes"],
  voice: number,
  line: number,
): FitNote[] {
  return notes.map((n) => fitNote(n, voice, line));
}
