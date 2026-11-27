// Synthetic sing state for the test-only screenshot page (`sing-test.html`) and the
// painter screenshots (#58): a made-up Song with placeholder lyrics, every
// Note kind, and lanes in distinct Party colours. Nothing here is a real Song.
// The Beat grid is a realistic `#BPM:120` (8 Beats a second), so the lanes
// scroll as a real Song's do. Each lane gets made-up Pitch readings: on pitch,
// an octave up (drawn folded), a sharp miss, an unvoiced gap, and readings
// ending 150 ms before the default 6 s, so the line is held to the playhead;
// the features sit in the last half second, the past a lane shows. The four-Player case's last lane
// has lost its Mic. Every lane has a made-up Player (one a Guest) and Score.
// A confetti burst from the first lane header (#134) is caught in flight: a
// seeded burst, aged a fixed time, so the screenshots stay exact (the page
// freezes the effects' frame time). The first lane's Line rating (Perfect!)
// and the second's (Great!) are caught settled, before they fade (#216).
// The title card (#264) shows a made-up title and artist with the Song's
// generated cover (#259, its letter drawn on the canvas), with the pause hint
// under it, until 4 s.
// The no-video case's 2 Players share the one Voice over the moving blobs
// (#263), caught at the frozen Song time; the other cases have no background,
// so the page's tile backdrop shows as before.

import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import { beatAt } from "../../clock/beats";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import type { AvatarKey } from "../../generated/AvatarKey";
import { PALETTE_KEYS, type PaletteKey } from "../../theme/tokens";
import type { SingTestCase } from "../../singTest/search";
import { confettiBurst, EFFECTS_CAPACITY, ParticlePool } from "./effects";
import { singVoices, type SingState } from "./frame";
import type { LyricSize } from "../../generated/LyricSize";
import type { SingSong } from "./titleCard";
import {
  generatedCover,
  generatedCoverDataUrl,
  type CoverSong,
} from "../../ui/generatedCover";
import { LineRatings } from "./lineRating";
import { DEFAULT_SING_LOOK, singLayout, type SingLook } from "./singLook";

/** How long the synthetic Line ratings have been showing, seconds. */
const RATING_AGE = 0.6;

/** Perfect! on the first lane and Great! on the second, `RATING_AGE` old. */
function ratings(): LineRatings {
  const pops = new LineRatings();
  pops.show(0, "sing.lineRating.perfect");
  pops.show(1, "sing.lineRating.great");
  // Advanced in steps no longer than a frame's most.
  for (let age = 0; age < RATING_AGE - 1e-9; age += 0.2) pops.advance(0.2);
  return pops;
}

/** How long the synthetic confetti burst has been flying, seconds. */
const BURST_AGE = 0.12;

/** A seeded confetti burst from the first lane header, `BURST_AGE` old. */
function burst(
  state: Pick<SingState, "lanes" | "voices" | "look">,
  colour: PaletteKey,
): ParticlePool {
  const pool = new ParticlePool(EFFECTS_CAPACITY, { seed: 134 });
  const rect = singLayout(state)[0];
  if (rect) {
    confettiBurst(
      pool,
      (rect.x + rect.notesX) / 2,
      rect.y + rect.height / 2,
      colour,
    );
  }
  // Stepped as a 144 Hz display would, though any steps land the same. Caught
  // early, so the confetti still covers the header: the effects canvas is above it.
  for (let i = 0; i < Math.round(BURST_AGE * 144); i++) pool.advance(1 / 144);
  return pool;
}

/**
 * `#BPM:120` (#BPM × 4 Beats a minute, an eighth of a second per Beat), Beat
 * 0 at 0.75 s: Song time 6 s is Beat 42, Beat 10 of the second pass.
 */
const GRID = { gapSeconds: 0.75, beatsPerMinute: 480 };

/** One pass of the pattern: [kind, start, length, pitch]. */
const PATTERN: [NoteKind, number, number, number][] = [
  ["normal", 4, 2, 0],
  ["golden", 6, 3, 2],
  ["normal", 10, 2, 4], // on the playhead at 6 s (Beat 42)
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
      line: r * (PATTERN.length + 1) + i + 1,
    }));
    // Each Line but the last ends at the next pass, as a `- beat` line would.
    const end =
      r + 1 < REPEATS
        ? {
            beat: (r + 1) * PATTERN_BEATS + beatShift,
            line: (r + 1) * (PATTERN.length + 1),
          }
        : null;
    lines.push({ notes, end });
  }
  return lines;
}

const LANES: Record<SingTestCase, number[]> = {
  one: [0],
  four: [0, 0, 0, 0],
  eight: [0, 0, 0, 0, 0, 0, 0, 0],
  duet: [0, 1],
  noVideo: [0, 0],
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
    if (ms >= 5450 && ms < 5550) pitch += 12; // an octave up
    if (ms >= 5550 && ms < 5630) pitch += 2.5; // a miss
    if (ms >= 5690 && ms < 5730) pitch = null; // a breath
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

const COVER_SONG: CoverSong = {
  id: 1,
  title: "Placeholder Song",
  tileColour: "navy",
};

/**
 * The made-up Song of the title card, with its generated cover in the
 * theme's colours as they are when the state is built.
 */
function syntheticSong(): SingSong {
  return {
    ...COVER_SONG,
    artist: "Nobody in Particular",
    cover: generatedCoverDataUrl(COVER_SONG, { letter: false }),
    letter: generatedCover(COVER_SONG).letter,
  };
}

/** Case `name` at Lyric size `lyricSize`, the other options at their defaults. */
export function syntheticSing(
  name: SingTestCase,
  lyricSize: LyricSize = "m",
): SingState {
  // Only the duet has a second Voice, so only its headers carry "· V1".
  const voices = singVoices({
    voices:
      name === "duet"
        ? [{ lines: voice(0, 0) }, { lines: voice(5, 2) }]
        : [{ lines: voice(0, 0) }],
  });
  const lanes = LANES[name];
  const look: SingLook = { ...DEFAULT_SING_LOOK, lyricSize };
  const state: SingState = {
    grid: GRID,
    voices,
    look,
    lanes: lanes.map((v, i) => ({
      colour: PALETTE_KEYS[i] ?? "cherry",
      voice: v,
      player: player(i),
      trace: {
        readings: readings(voices[v]?.notes ?? [], 20 * i),
        micThresholdDbfs: -45,
        difficulty: "medium",
        lostAt: name === "four" && i === lanes.length - 1 ? 5.6 : null,
      },
    })),
    ratings: ratings(),
    // No cover image: the generated cover (#259), so the page needs no
    // network.
    song: syntheticSong(),
    pauseHint: "keyboard",
    ...(name === "noVideo"
      ? { background: { kind: "blobs", still: false } as const }
      : {}),
  };
  return { ...state, effects: burst(state, PALETTE_KEYS[0]) };
}
