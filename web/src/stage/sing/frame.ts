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
import type { Avatar } from "../../generated/Avatar";
import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import type { PaletteKey, TokenName } from "../../theme/tokens";
import type { LaneLayout } from "./laneLayout";
import {
  noteIndex,
  traceLane,
  type HeadBallEntry,
  type LaneTrace,
  type NoteIndex,
  type PitchLineEntry,
} from "./pitchTrace";

import {
  backgroundEntry,
  type BackgroundEntry,
  type SingBackground,
} from "./background";
import type { ParticleEntry, ParticlePool } from "./effects";
import type { LineRatingEntry, LineRatings } from "./lineRating";
import {
  BAR_RIGHT,
  TIME_LEFT_ROOM,
  topBand,
  type PauseHint,
  type PauseHintEntry,
  type SingSong,
  type TimeLeftEntry,
  type TitleCardEntry,
} from "./titleCard";

export type { BackgroundEntry, BlobStyle } from "./background";
export type { ParticleEntry } from "./effects";
export type { LineRatingEntry } from "./lineRating";
export type {
  CoverStyle,
  PauseHint,
  PauseHintEntry,
  SingSong,
  TextStyle,
  TimeLeftEntry,
  TitleCardEntry,
} from "./titleCard";
export type {
  HeadBallEntry,
  LaneTrace,
  PitchLineEntry,
  TracePoint,
} from "./pitchTrace";

/** One Voice as the sing screen draws it: its Notes in order and its pitch span. */
export interface SingVoice {
  notes: readonly Note[];
  /** The Voice's Lines in file order, for the lyric bar and its fill. */
  lines: readonly Line[];
  /** Lowest Note pitch (semitones from C4). */
  lowestPitch: number;
  /** Highest Note pitch. */
  highestPitch: number;
  /** Which Note is under, or nearest to, each Beat (for the pitch trace). */
  index: NoteIndex;
  /** The Beat the Voice's last Note ends on. */
  endBeat: number;
}

/** Who sings in a lane, for its header (DOM, not the draw list). */
export interface LanePlayer {
  name: string;
  avatar: Avatar;
  /** A Guest's header says "guest" after the name. */
  guest: boolean;
  /** The running Score (#54 feeds it). */
  score: number;
}

/** One Player's lane: their Party colour and the Voice they sing. */
export interface SingLane {
  colour: PaletteKey;
  /** The lane header's Player; none: an empty header. */
  player?: LanePlayer;
  /** Index into `SingState.voices`. */
  voice: number;
  /** The Player's readings and Mic for the pitch line; none: no line. */
  trace?: LaneTrace;
}

/** Everything `frame()` needs that does not change from frame to frame. */
export interface SingState {
  grid: BeatGrid;
  voices: readonly SingVoice[];
  /** One per Player, in Player order. */
  lanes: readonly SingLane[];
  /**
   * The Song's length in seconds (`#END`, else the audio's), for the
   * progress bar; without one, the end of the last Note.
   */
  lengthSeconds?: number | null;
  /**
   * The effects' particle pool (#134). Game code bursts into it; the render
   * loop advances it by each frame's real delta, and `frame()` only reads it.
   */
  effects?: ParticlePool;
  /**
   * The lanes' Line rating pops (#216). `lineEnded` starts one; the render
   * loop advances them by each frame's real delta, and `frame()` only reads
   * them.
   */
  ratings?: LineRatings;
  /** The Song's title, artist and cover, for the title card (#264); none: no card. */
  song?: SingSong | null;
  /**
   * The pause hint under the title card (#264), naming this input; only on
   * the first Song since the Party started. None: no hint.
   */
  pauseHint?: PauseHint | null;
  /**
   * What is behind the lanes (#263), chosen at Start: the Song video, its
   * background image, or the blobs the painter draws. None: no background
   * entry, and the painter draws no background.
   */
  background?: SingBackground;
}

/** A parsed Song's Voices, flattened once for drawing (not per frame). */
export function singVoices(song: Pick<ParsedSong, "voices">): SingVoice[] {
  return song.voices.map((voice) => {
    const notes = voice.lines.flatMap((line) => line.notes);
    let lowestPitch = Infinity;
    let highestPitch = -Infinity;
    let endBeat = 0;
    for (const n of notes) {
      lowestPitch = Math.min(lowestPitch, n.pitch);
      highestPitch = Math.max(highestPitch, n.pitch);
      endBeat = Math.max(endBeat, n.start + n.length);
    }
    if (notes.length === 0) lowestPitch = highestPitch = 0;
    return {
      notes,
      lines: voice.lines,
      lowestPitch,
      highestPitch,
      index: noteIndex(notes),
      endBeat,
    };
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
  /** The lane panel's corner radius; the Notes are clipped to its shape. */
  radius: number;
  colour: PaletteKey;
  /** The lane's Mic is lost: the lane is greyed over its panel. */
  lost: LostStyle | null;
  /** The thin vertical line just left of the Notes area. */
  separator: LineStyle & { x: number; top: number; bottom: number };
}

/** The grey wash over a lost lane, a rounded rectangle the size of the lane. */
export interface LostStyle {
  colour: TokenName;
  alpha: number;
  radius: number;
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
  /** The white star near a golden pill's left end; `null`: none. */
  star: StarStyle | null;
  /** The shimmer band sweeping across a golden pill; `null`: none. */
  shimmer: ShimmerStyle | null;
}

/** A five-pointed star centred on `x`, `y`, one point up. */
export interface StarStyle {
  x: number;
  y: number;
  /** Radius of the points. */
  outer: number;
  /** Radius of the notches between the points. */
  inner: number;
  colour: TokenName;
}

/**
 * A soft vertical band, clear at both edges and `colour` at `alpha` in the
 * middle, from `x` to `x + width`, clipped to its pill.
 */
export interface ShimmerStyle {
  x: number;
  width: number;
  colour: TokenName;
  alpha: number;
}

/** The faint pitch grid of a lane: horizontal lines at `ys`, inside the lane's clip. */
export interface GridEntry extends LineStyle {
  type: "grid";
  lane: number;
  left: number;
  right: number;
  ys: readonly number[];
}

/** The Song's progress bar: a full-radius track with a fill `fraction` long. */
export interface ProgressEntry {
  type: "progress";
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0 at the Song's start, 1 at its end. */
  fraction: number;
  track: TokenName;
  trackAlpha: number;
  fill: TokenName;
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

/**
 * One Voice's lyric fill, for the lyric bar (DOM, not the canvas). The
 * render loop writes `fraction` to a CSS custom property on the current
 * Note's text; React re-renders the text only when `line` changes.
 */
export interface LyricEntry {
  type: "lyric";
  /** Index into `SingState.voices`. */
  voice: number;
  /** Index of the current Line in the Voice's `lines`; -1: the Voice has none. */
  line: number;
  /**
   * The current Note's index in that Line: the last one that has started;
   * -1 before the Line's first Note. The Notes before it are fully sung.
   */
  note: number;
  /** How much of the current Note's text is filled, 0 to 1. */
  fraction: number;
  /** The current Note is being sung right now (its text lifts). */
  singing: boolean;
  /** The Party colour of the one Player on this Voice; slate when several (or none) share it. */
  colour: LyricColour;
}

export type LyricColour = PaletteKey | "--color-slate";

/** Ends the clip a `lane` entry started. */
export interface LaneEndEntry {
  type: "laneEnd";
  lane: number;
}

export type DrawEntry =
  | BackgroundEntry
  | ProgressEntry
  | LaneEntry
  | GridEntry
  | PillEntry
  | PlayheadEntry
  | PitchLineEntry
  | HeadBallEntry
  | LaneEndEntry
  | LyricEntry
  | LineRatingEntry
  | TitleCardEntry
  | PauseHintEntry
  | TimeLeftEntry
  | ParticleEntry;
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

/** The pitch grid's step, in semitones. */
const GRID_STEP = 2;
/** A golden pill gets its star from this height up. */
const STAR_MIN_HEIGHT = 18;
/** The star's point radius as a share of the pill height, and its notch ratio. */
const STAR_OUTER = 0.34;
const STAR_INNER = 0.45;
/** One shimmer sweep across a golden pill, in seconds of Song time. */
const SHIMMER_PERIOD = 1.5;
/** The shimmer band's width in px, and its strongest alpha. */
export const SHIMMER_WIDTH = 48;
const SHIMMER_ALPHA = 0.6;
/**
 * The progress bar (#55): 80 px from each side, 20 px from the top, leaving
 * room at its right end for the time left (#264).
 */
const PROGRESS = {
  x: 80,
  y: 20,
  width: BAR_RIGHT - TIME_LEFT_ROOM - 80,
  height: 10,
};

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
 * A Voice's lyric fill colour (#55): the Player's Party colour when exactly
 * one Player sings the Voice, slate when several share it or none sings it.
 */
function lyricColour(state: SingState, voice: number): LyricColour {
  let colour: LyricColour = "--color-slate";
  let players = 0;
  for (const lane of state.lanes) {
    if (lane.voice !== voice) continue;
    players++;
    colour = lane.colour;
  }
  return players === 1 ? colour : "--color-slate";
}

/**
 * Pushes one `lyric` entry per Voice. The current Line is the first whose
 * Line end marker's Beat is still ahead (the last Line has none); in it, the
 * current Note is the last one that has started.
 */
function lyricFill(list: DrawList, state: SingState, now: number) {
  for (let v = 0; v < state.voices.length; v++) {
    const lines = state.voices[v]?.lines ?? [];
    let line = lines.length - 1;
    for (let i = 0; i < lines.length; i++) {
      const end = lines[i]?.end;
      if (!end || now < end.beat) {
        line = i;
        break;
      }
    }
    const notes = lines[line]?.notes ?? [];
    let note = -1;
    while (note + 1 < notes.length && (notes[note + 1]?.start ?? 0) <= now) {
      note++;
    }
    const current = notes[note];
    let fraction = 0;
    let singing = false;
    if (current) {
      const sung = now - current.start;
      fraction = current.length > 0 ? Math.min(1, sung / current.length) : 1;
      singing = sung < current.length;
    }
    list.push({
      type: "lyric",
      voice: v,
      line,
      note,
      fraction,
      singing,
      colour: lyricColour(state, v),
    });
  }
}

/** The Song's length in seconds, for the progress bar. */
function songLength(state: SingState): number {
  if (state.lengthSeconds != null && state.lengthSeconds > 0) {
    return state.lengthSeconds;
  }
  let endBeat = 0;
  for (const voice of state.voices) endBeat = Math.max(endBeat, voice.endBeat);
  return beatStart(state.grid, endBeat);
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
  const length = songLength(state);
  // First: the background layer is below everything else.
  if (state.background) {
    list.push(backgroundEntry(state.background, state.lanes, songTime));
  }
  list.push({
    type: "progress",
    ...PROGRESS,
    fraction: length > 0 ? Math.min(1, Math.max(0, songTime / length)) : 0,
    track: "--color-white",
    trackAlpha: 0.5,
    fill: "--color-yellow",
  });
  topBand(list, state, songTime, length);

  for (let lane = 0; lane < lanes; lane++) {
    const player = state.lanes[lane];
    const rect = layout[lane];
    const voice = player && state.voices[player.voice];
    if (!player || !rect || !voice) continue;

    const padding = rect.height < 150 ? 12 : 22;
    const trace = player.trace;
    const lost =
      trace !== undefined && trace.lostAt !== null && trace.lostAt <= songTime;
    const radius = Math.min(40, rect.height / 2);
    list.push({
      type: "lane",
      lane,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      notesX: rect.notesX,
      radius,
      colour: player.colour,
      lost: lost ? { colour: "--color-slate", alpha: 0.55, radius } : null,
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
    // The lane scrolls at a fixed speed in time, so a Beat's width follows the BPM.
    const pixelsPerBeat =
      (rect.pixelsPerSecond * 60) / state.grid.beatsPerMinute;

    const ys: number[] = [];
    for (let step = 0; step <= range; step += GRID_STEP) {
      ys.push(bottom - (step / range) * inner);
    }
    list.push({
      type: "grid",
      lane,
      left: rect.notesX,
      right,
      ys,
      colour: "--color-ink",
      alpha: 0.07,
      width: 2,
    });

    for (const note of voice.notes) {
      const x = rect.playheadX + (note.start - now) * pixelsPerBeat;
      // Lines keep file order and Notes are never re-sorted, so check each.
      if (x > right) continue;
      const width = Math.max(0, (note.length - PILL_GAP_BEATS) * pixelsPerBeat);
      if (x + width < rect.notesX) continue;
      const passed = x + width <= rect.playheadX;
      const centre = bottom - ((note.pitch - low) / range) * inner;
      const rap = note.kind === "rap" || note.kind === "goldenRap";
      const golden =
        !passed && (note.kind === "golden" || note.kind === "goldenRap");
      // Where the shimmer band is in its sweep, 0 to 1, from the Note's start.
      const since = golden ? songTime - beatStart(state.grid, note.start) : 0;
      const sweep =
        (((since % SHIMMER_PERIOD) + SHIMMER_PERIOD) % SHIMMER_PERIOD) /
        SHIMMER_PERIOD;
      const y = centre - height / 2;
      list.push({
        type: "pill",
        lane,
        note,
        kind: note.kind,
        passed,
        x,
        y,
        width,
        height,
        fill: pillFill(note.kind, passed),
        outline:
          passed && note.kind === "freestyle"
            ? "--color-passed"
            : "--color-ink",
        outlineWidth: outline,
        dash: rap ? (RAP_DASH.get(outline) ?? SOLID) : SOLID,
        star:
          golden && height >= STAR_MIN_HEIGHT
            ? {
                x: x + height / 2,
                y: centre,
                outer: height * STAR_OUTER,
                inner: height * STAR_OUTER * STAR_INNER,
                colour: "--color-white",
              }
            : null,
        shimmer: golden
          ? {
              x: x - SHIMMER_WIDTH + sweep * (width + SHIMMER_WIDTH),
              width: SHIMMER_WIDTH,
              colour: "--color-white",
              alpha: SHIMMER_ALPHA,
            }
          : null,
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
    if (trace) {
      traceLane(
        list,
        trace,
        {
          lane,
          colour: player.colour,
          playheadX: rect.playheadX,
          pixelsPerSecond: rect.pixelsPerSecond,
          notesX: rect.notesX,
          height: rect.height,
          low,
          range,
          inner,
          bottom,
        },
        state.grid,
        voice.notes,
        voice.index,
        songTime,
      );
    }
    list.push({ type: "laneEnd", lane });
  }
  lyricFill(list, state, now);
  state.ratings?.draw(list, state.lanes, layout);
  // Last: the painter draws these on the effects canvas, above the DOM layers.
  state.effects?.draw(list);
  return list;
}
