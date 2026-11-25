// Synthetic sing state for the test-only entry (`/stage/sing-test`) and the
// painter screenshots (#58): a made-up Song with placeholder lyrics, every
// Note kind, and lanes in distinct Party colours. Nothing here is a real Song.

import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import { PALETTE_KEYS } from "../../theme/tokens";
import type { SingTestCase } from "../../singTestSearch";
import { singVoices, type SingState } from "./frame";

/** Beat 0 at 1 s, half a second per Beat: Song time 6 s is Beat 10. */
const GRID = { gapSeconds: 1, beatsPerMinute: 120 };

/** One pass of the pattern: [kind, start, length, pitch]. */
const PATTERN: [NoteKind, number, number, number][] = [
  ["normal", 4, 2, 0],
  ["golden", 6, 3, 2],
  ["normal", 10, 2, 4], // on the playhead at Beat 10
  ["rap", 13, 2, 4],
  ["golden", 16, 4, 7],
  ["goldenRap", 21, 2, 5],
  ["freestyle", 24, 3, 3],
  ["normal", 28, 1, 0],
  ["normal", 29, 2, 2],
];
const PATTERN_BEATS = 32;
const REPEATS = 4;

function voice(pitchShift: number, beatShift: number): Line[] {
  const lines: Line[] = [];
  for (let r = 0; r < REPEATS; r++) {
    const notes: Note[] = PATTERN.map(([kind, start, length, pitch], i) => ({
      kind,
      start: start + beatShift + r * PATTERN_BEATS,
      length,
      pitch: pitch + pitchShift,
      text: "la ",
      line: r * PATTERN.length + i + 1,
    }));
    lines.push({ notes, end: null });
  }
  return lines;
}

const LANES: Record<SingTestCase, number[]> = {
  one: [0],
  four: [0, 0, 0, 0],
  eight: [0, 0, 0, 0, 0, 0, 0, 0],
  duet: [0, 1],
};

export function syntheticSing(name: SingTestCase): SingState {
  return {
    grid: GRID,
    voices: singVoices({
      voices: [{ lines: voice(0, 0) }, { lines: voice(5, 2) }],
    }),
    lanes: LANES[name].map((v, i) => ({
      colour: PALETTE_KEYS[i] ?? "cherry",
      voice: v,
    })),
  };
}
