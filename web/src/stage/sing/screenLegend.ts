/**
 * The samples of the pause menu's "How to read the screen" card (#258), as
 * draw lists for the sing screen's own painter. Nothing here picks a colour or
 * a size: each Note sample is one pill from `frame()` itself, built from a
 * one-Note Song, and each pitch line sample is a run from `pitchLineEntry`,
 * the sing screen's own. So the samples can never drift from the real screen.
 *
 * Coordinates are in a `LEGEND_SAMPLE.width` × `height` box of the reference
 * frame, drawn at the scale of a one-lane sing screen's Notes.
 */

import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import { PALETTE_KEYS, type PaletteKey } from "../../theme/tokens";
import { frame, type DrawList, type SingState, type TracePoint } from "./frame";
import type { LaneRect } from "./laneLayout";
import { noteIndex, pitchLineEntry } from "./pitchTrace";

const [FIRST_COLOUR] = PALETTE_KEYS;

/** One sample's box, and the Party colour its pitch line and lyric fill use. */
export const LEGEND_SAMPLE = {
  width: 240,
  height: 136,
  colour: FIRST_COLOUR satisfies PaletteKey as PaletteKey,
} as const;

/** px per second (and per Beat, at the samples' 60 BPM). */
const PIXELS_PER_SECOND = 100;
/** Every sample's Note: Beat 0.2 to 2.4, drawn from x 20 to 220. */
const START = 0.2;
const LENGTH = 2.2;
/** Song time at which a sample's Note has just passed the playhead. */
const PASSED_AT = 2.4;
/** Song time at which a golden pill's shimmer is near its middle. */
const SHIMMER_AT = 0.875;

/** The pill's centre line: a one-pitch lane draws its Notes halfway up. */
const MIDDLE = LEGEND_SAMPLE.height / 2;

/** The legend's Note looks: the four Note kinds, and a Note already sung. */
export type LegendNoteKind =
  "normal" | "golden" | "rap" | "freestyle" | "passed";

export interface LegendSample<Kind> {
  kind: Kind;
  list: DrawList;
}

/** A one-Note Song of `kind` at Song time `songTime`: only its pill. */
function pill(kind: NoteKind, songTime: number): DrawList {
  const note: Note = {
    kind,
    start: START,
    length: LENGTH,
    pitch: 0,
    text: "",
    line: 0,
  };
  const state: SingState = {
    grid: { gapSeconds: 0, beatsPerMinute: 60 },
    voices: [
      {
        notes: [note],
        lines: [],
        lowestPitch: 0,
        highestPitch: 0,
        index: noteIndex([note]),
        endBeat: START + LENGTH,
      },
    ],
    lanes: [{ colour: LEGEND_SAMPLE.colour, voice: 0 }],
  };
  // The playhead moves with Song time, so the Note always sits at x 20.
  const rect: LaneRect = {
    x: 0,
    y: 0,
    width: LEGEND_SAMPLE.width,
    height: LEGEND_SAMPLE.height,
    notesX: 0,
    playheadX: songTime * PIXELS_PER_SECOND,
    pixelsPerSecond: PIXELS_PER_SECOND,
  };
  return frame(state, songTime, [rect]).filter(
    (entry) => entry.type === "pill",
  );
}

export function legendNoteSamples(): LegendSample<LegendNoteKind>[] {
  return [
    { kind: "normal", list: pill("normal", 0) },
    { kind: "golden", list: pill("golden", SHIMMER_AT) },
    { kind: "rap", list: pill("rap", 0) },
    { kind: "freestyle", list: pill("freestyle", 0) },
    { kind: "passed", list: pill("normal", PASSED_AT) },
  ];
}

/** A gently wavering run from x 30 to 210 around `y`. */
function run(y: number, hit: boolean): TracePoint[] {
  const points: TracePoint[] = [];
  for (let i = 0; i <= 12; i++) {
    points.push({
      songTime: i / 10,
      pitch: 0,
      x: 30 + i * 15,
      y: y + 3 * Math.sin(i * 0.9),
      hit,
      guessed: false,
    });
  }
  return points;
}

/** On pitch along the Note, and off pitch above it. */
export function legendPitchSamples(): LegendSample<"hit" | "miss">[] {
  const line = (y: number, hit: boolean) =>
    pitchLineEntry(0, LEGEND_SAMPLE.colour, LEGEND_SAMPLE.height, run(y, hit));
  return [
    { kind: "hit", list: [...pill("normal", 0), line(MIDDLE, true)] },
    { kind: "miss", list: [...pill("normal", 0), line(MIDDLE - 40, false)] },
  ];
}
