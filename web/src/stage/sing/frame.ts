/**
 * The sing screen's frame as data: a pure function of the sing state, the
 * Song time to draw and the lane layout. It reads no clock, DOM or global
 * state, so tests check it without pixels; the painter turns its draw list
 * into canvas calls and holds no game logic.
 *
 * Every position is computed from Song time each frame, never moved step by
 * step, so a dropped frame causes no drift. Colours are palette keys or token
 * names, never colour values; the painter resolves them through the tokens.
 *
 * Sizes are #55's, in the 1920 × 1080 reference frame.
 */

import { beatAt, beatStart, type BeatGrid } from "../../clock/beats";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import type { PaletteKey, TokenName } from "../../theme/tokens";
import type { LaneLayout } from "./laneLayout";

/** One Voice as the sing screen draws it: its Notes in order and its pitch span. */
export interface SingVoice {
  notes: readonly Note[];
  /** Lowest Note pitch (semitones from C4). */
  lowestPitch: number;
  /** Highest Note pitch. */
  highestPitch: number;
}

/** One Player's lane: their Party colour and the Voice they sing. */
export interface SingLane {
  colour: PaletteKey;
  /** Index into `SingState.voices`. */
  voice: number;
}

/** Everything `frame()` needs that does not change from frame to frame. */
export interface SingState {
  grid: BeatGrid;
  voices: readonly SingVoice[];
  /** One per Player, in Player order. */
  lanes: readonly SingLane[];
}

/** A parsed Song's Voices, flattened once for drawing (not per frame). */
export function singVoices(song: Pick<ParsedSong, "voices">): SingVoice[] {
  return song.voices.map((voice) => {
    const notes = voice.lines.flatMap((line) => line.notes);
    let lowestPitch = Infinity;
    let highestPitch = -Infinity;
    for (const n of notes) {
      lowestPitch = Math.min(lowestPitch, n.pitch);
      highestPitch = Math.max(highestPitch, n.pitch);
    }
    if (notes.length === 0) lowestPitch = highestPitch = 0;
    return { notes, lowestPitch, highestPitch };
  });
}

/** How a pill is filled. */
export type PillFill =
  | { readonly type: "solid"; readonly colour: TokenName }
  | {
      readonly type: "vertical";
      readonly top: TokenName;
      readonly bottom: TokenName;
    };

/** A lane's rectangle. The painter clips the lane's Notes to its Notes area until `laneEnd`. */
export interface LaneEntry {
  type: "lane";
  lane: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The Notes area runs from here to the lane's right edge. */
  notesX: number;
  colour: PaletteKey;
  /** The thin vertical line just left of the Notes area. */
  separator: LineStyle & { x: number; top: number; bottom: number };
}

/** How a straight line is stroked. */
export interface LineStyle {
  colour: TokenName;
  alpha: number;
  width: number;
}

/** A Note pill, full radius. `x`, `y` is its top-left corner. */
export interface PillEntry {
  type: "pill";
  lane: number;
  note: Note;
  kind: NoteKind;
  /** The pill's end has crossed the playhead. */
  passed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `null`: hollow (Freestyle). */
  fill: PillFill | null;
  outline: TokenName;
  outlineWidth: number;
  /** Canvas line dash; empty for a solid outline. */
  dash: readonly number[];
}

/** The fixed playhead of a lane: a dotted vertical line with round caps. */
export interface PlayheadEntry {
  type: "playhead";
  lane: number;
  x: number;
  top: number;
  bottom: number;
  colour: TokenName;
  alpha: number;
  width: number;
  dash: readonly number[];
}

/** Ends the clip a `lane` entry started. */
export interface LaneEndEntry {
  type: "laneEnd";
  lane: number;
}

export type DrawEntry = LaneEntry | PillEntry | PlayheadEntry | LaneEndEntry;
export type DrawList = DrawEntry[];

// Shared constants, so a frame allocates nothing beyond its own entries.
const WHITE: PillFill = { type: "solid", colour: "--color-white" };
const PASSED: PillFill = { type: "solid", colour: "--color-passed" };
const GOLDEN: PillFill = {
  type: "vertical",
  top: "--color-golden-top",
  bottom: "--color-golden-bottom",
};
const SOLID: readonly number[] = [];
const PLAYHEAD_DASH: readonly number[] = [1, 12];
/** Rap outlines: dashes and gaps each twice the outline width. */
const RAP_DASH = new Map<number, readonly number[]>(
  [2.5, 3.5, 4.5].map((w) => [w, [2 * w, 2 * w]]),
);

/** Semitones a lane shows beyond its Voice's lowest and highest Note. */
const PITCH_MARGIN = 2;
const SEPARATOR_WIDTH = 2;
/** A pill is this much shorter than its Note, in Beats, to leave a gap. */
const PILL_GAP_BEATS = 0.2;

function outlineWidth(height: number): number {
  if (height < 14) return 2.5;
  if (height < 20) return 3.5;
  return 4.5;
}

function pillFill(kind: NoteKind, passed: boolean): PillFill | null {
  if (kind === "freestyle") return null;
  if (passed) return PASSED;
  return kind === "golden" || kind === "goldenRap" ? GOLDEN : WHITE;
}

/** The Beat position at Song time `t`, fractional between Beats. */
function beatPosition(grid: BeatGrid, t: number): number {
  const beat = beatAt(grid, t);
  return beat + ((t - beatStart(grid, beat)) * grid.beatsPerMinute) / 60;
}

/**
 * The draw list for Song time `songTime` (seconds, already shifted by the
 * Stage's A/V offset). Lane `i` of `state.lanes` is drawn in `layout[i]`.
 */
export function frame(
  state: SingState,
  songTime: number,
  layout: LaneLayout,
): DrawList {
  const list: DrawList = [];
  const now = beatPosition(state.grid, songTime);
  const lanes = Math.min(state.lanes.length, layout.length);

  for (let lane = 0; lane < lanes; lane++) {
    const player = state.lanes[lane];
    const rect = layout[lane];
    const voice = player && state.voices[player.voice];
    if (!player || !rect || !voice) continue;

    const padding = rect.height < 150 ? 12 : 22;
    list.push({
      type: "lane",
      lane,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      notesX: rect.notesX,
      colour: player.colour,
      separator: {
        x: rect.notesX - SEPARATOR_WIDTH,
        top: rect.y + padding,
        bottom: rect.y + rect.height - padding,
        colour: "--color-ink",
        alpha: 0.12,
        width: SEPARATOR_WIDTH,
      },
    });

    const low = voice.lowestPitch - PITCH_MARGIN;
    const range = voice.highestPitch + PITCH_MARGIN - low;
    const inner = rect.height - 2 * padding;
    const bottom = rect.y + rect.height - padding;
    const height = Math.min(42, Math.max(8, (inner / range) * 1.5));
    const outline = outlineWidth(height);
    const right = rect.x + rect.width;

    for (const note of voice.notes) {
      const x = rect.playheadX + (note.start - now) * rect.pixelsPerBeat;
      // Lines keep file order and Notes are never re-sorted, so check each.
      if (x > right) continue;
      const width = Math.max(
        0,
        (note.length - PILL_GAP_BEATS) * rect.pixelsPerBeat,
      );
      if (x + width < rect.notesX) continue;
      const passed = x + width <= rect.playheadX;
      const centre = bottom - ((note.pitch - low) / range) * inner;
      const rap = note.kind === "rap" || note.kind === "goldenRap";
      list.push({
        type: "pill",
        lane,
        note,
        kind: note.kind,
        passed,
        x,
        y: centre - height / 2,
        width,
        height,
        fill: pillFill(note.kind, passed),
        outline:
          passed && note.kind === "freestyle"
            ? "--color-passed"
            : "--color-ink",
        outlineWidth: outline,
        dash: rap ? (RAP_DASH.get(outline) ?? SOLID) : SOLID,
      });
    }

    list.push({
      type: "playhead",
      lane,
      x: rect.playheadX,
      top: rect.y,
      bottom: rect.y + rect.height,
      colour: "--color-ink",
      alpha: 0.3,
      width: 4,
      dash: PLAYHEAD_DASH,
    });
    list.push({ type: "laneEnd", lane });
  }
  return list;
}
