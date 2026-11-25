// Synthetic sing state for the test-only screenshot page (`sing-test.html`) and the
// painter screenshots (#58): a made-up Song with placeholder lyrics, every
// Note kind, and lanes in distinct Party colours. Nothing here is a real Song.
// Each lane gets made-up Pitch readings: on pitch, an octave up (drawn folded),
// a sharp miss, an unvoiced gap, and readings ending 150 ms before the default
// 6 s, so the line is held to the playhead. The four-Player case's last lane
// has lost its Mic. Every lane has a made-up Player (one a Guest) and Score.

import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import { beatAt } from "../../clock/beats";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import type { AvatarKey } from "../../generated/AvatarKey";
import { PALETTE_KEYS } from "../../theme/tokens";
import type { SingTestCase } from "../../singTest/search";
import { singVoices, type SingState } from "./frame";

/** Beat 0 at 1 s, half a second per Beat: Song time 6 s is Beat 10. */
const GRID = { gapSeconds: 1, beatsPerMinute: 120 };

/** One pass of the pattern: [kind, start, length, pitch]. */
const PATTERN: [NoteKind, number, number, number][] = [
  ["normal", 4, 2, 0],
  ["golden", 6, 3, 2],
  ["normal", 10, 2, 4], // on the playhead at Beat 10
  ["rap", 13, 2, 4],
  ["golden", 16, 4, 6], // a span of 6 keeps one lane's pills ≥ 18 px: stars
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

/** Made-up Players, in lane order: [name, avatar, Score]. The second is a Guest. */
const PLAYERS: [string, AvatarKey, number][] = [
  ["Mia", "star", 4120],
  ["Bo", "moon", 3875],
  ["Alexandra", "rocket", 2950],
  ["Kai", "cat", 1630],
  ["Lou", "flower", 920],
  ["Noor", "guitar", 7310],
  ["Sam", "ghost", 0],
  ["Tess", "planet", 10000],
];

/** Readings run from here to here, every 10 ms (Song time, ms). */
const SUNG_FROM_MS = 2500;
const SUNG_TO_MS = 5850;

/** Made-up readings for one Player singing `notes`, `cents` off. */
function readings(notes: readonly Note[], cents: number): PitchBuffer {
  const buffer = new PitchBuffer(1000);
  let target = notes[0]?.pitch ?? 0;
  for (let ms = SUNG_FROM_MS; ms <= SUNG_TO_MS; ms += 10) {
    const t = ms / 1000;
    const beat = beatAt(GRID, t);
    const under = notes.find(
      (n) => beat >= n.start && beat < n.start + n.length,
    );
    if (under) target = under.pitch;
    let pitch: number | null =
      60 + target + cents / 100 + 0.15 * Math.sin(t * 30);
    if (ms >= 4000 && ms < 4600) pitch += 12; // an octave up
    if (ms >= 4600 && ms < 4800) pitch += 2.5; // a miss
    if (ms >= 4950 && ms < 5050) pitch = null; // a breath
    buffer.push(
      {
        captureMs: ms,
        pitch,
        clarity: pitch === null ? 0.3 : 0.95,
        loudness: -20,
      },
      t,
    );
  }
  return buffer;
}

function player(i: number) {
  const [name, key, score] = PLAYERS[i] ?? ["Pat", "note", 0];
  return {
    name,
    avatar: { kind: "builtIn" as const, key },
    guest: i === 1,
    score,
  };
}

export function syntheticSing(name: SingTestCase): SingState {
  // Only the duet has a second Voice, so only its headers carry "· V1".
  const voices = singVoices({
    voices:
      name === "duet"
        ? [{ lines: voice(0, 0) }, { lines: voice(5, 2) }]
        : [{ lines: voice(0, 0) }],
  });
  const lanes = LANES[name];
  return {
    grid: GRID,
    voices,
    lanes: lanes.map((v, i) => ({
      colour: PALETTE_KEYS[i] ?? "cherry",
      voice: v,
      player: player(i),
      trace: {
        readings: readings(voices[v]?.notes ?? [], 20 * i),
        micThresholdDbfs: -45,
        difficulty: "medium",
        lostAt: name === "four" && i === lanes.length - 1 ? 5 : null,
      },
    })),
  };
}
