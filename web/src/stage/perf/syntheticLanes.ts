/**
 * `?perf&lanes=8` (#227): synthetic lanes for the sing screen's performance
 * check, because v1 seats 4. They take the current Song's Voices in turn (a
 * duet alternates them) and replay recorded Pitch readings from
 * `fixtures/readings/` as if each lane's Phone sent them: each row becomes a
 * reading captured on the Stage's clock, placed on Song time with the run's
 * Mic delay by the same placement real readings get, and pushed into the
 * lane's own ring buffer. `frame()` and the painter then draw them like any
 * lane, effects included: a lane pops a Line rating as each of its Voice's
 * Lines ends (Perfect! throws confetti) and its golden Notes sparkle.
 *
 * Nothing here scores or reaches the server: the ratings are made up in turn,
 * and the module has no way to send.
 */

import { beatStart } from "../../clock/beats";
import { placedSongTime, type PlacementClock } from "../../clock/placement";
import type { PitchReading } from "../../generated/PitchReading";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import { pitchBufferCapacity } from "../../pitch/pitchCapacity";
import { lineRatingWord } from "../../scoring/constants";
import { LINE_RATING_KEYS } from "../../scoring/scorer";
import { MIC_THRESHOLD } from "../../mics/micSettings";
import { PALETTE_KEYS } from "../../theme/tokens";
import { EFFECTS_CAPACITY, ParticlePool } from "../sing/effects";
import type { SingLane, SingState, SingVoice } from "../sing/frame";
import { laneLayout } from "../sing/laneLayout";
import { LineRatings, lineEnded } from "../sing/lineRating";

/** One recorded run (`fixtures/readings/README.md`). */
export interface ReadingsRun {
  kind: "bleed" | "singing";
  micDelayMs: number;
  /** `[captureMs, pitch, clarity, loudness]`, in capture order. */
  readings: readonly (readonly [number, number | null, number, number])[];
}

/** The runs in `files` (path → JSON text), singing runs first, each by file name. */
export function readingsRuns(files: Record<string, string>): ReadingsRun[] {
  const runs = Object.keys(files)
    .sort()
    .map((path) => JSON.parse(files[path] ?? "{}") as ReadingsRun);
  return [
    ...runs.filter((run) => run.kind === "singing"),
    ...runs.filter((run) => run.kind !== "singing"),
  ];
}

/** Each lane starts its run this much after the previous lane, ms. */
const LANE_STAGGER_MS = 250;
/** Rows due longer ago than this are skipped, not placed (a hidden tab). */
const CATCH_UP_MS = 2000;
/** The made-up Line ratings, taken in turn: plenty of Perfect! confetti. */
const RATINGS = [8, 6, 8, 4, 7, 2, 8, 5] as const;

export interface SyntheticLanesOptions {
  /** The real sing state: its Song, Voices and Players' looks. */
  base: SingState;
  /** How many lanes, 1–8. */
  count: number;
  /** The recorded runs; lane `i` replays run `i` (in turn). */
  runs: readonly ReadingsRun[];
  /** The Song clock, for placement only. */
  clock: PlacementClock;
  /** The Stage clock, ms (`performance.now`). */
  now: () => number;
}

export interface SyntheticLanes {
  /** What the sing screen draws instead of the real lanes. */
  state: SingState;
  /** Feeds every reading that is due; call once per animation frame. */
  tick(): void;
}

interface Feed {
  lane: number;
  run: ReadingsRun;
  buffer: PitchBuffer;
  voice: number;
  /** Where its run starts on the Stage clock, ms. */
  startAt: number;
  /** One run's length, ms; a pass shifts the rows by it. */
  runMs: number;
  firstMs: number;
  row: number;
  pass: number;
  /** The next Line of its Voice to end. */
  line: number;
  /** How many Lines it rated. */
  rated: number;
  reading: PitchReading;
}

/** The Song time each Line of `voice` ends at, seconds, ascending. */
function lineEnds(state: SingState, voice: SingVoice): Float64Array {
  const ends = voice.lines.map((line) => {
    let end = -Infinity;
    for (const note of line.notes)
      end = Math.max(end, note.start + note.length);
    return beatStart(state.grid, end);
  });
  return Float64Array.from(ends.filter(Number.isFinite).sort((a, b) => a - b));
}

export function createSyntheticLanes(
  options: SyntheticLanesOptions,
): SyntheticLanes {
  const { base, count, runs, clock, now } = options;
  const voiceCount = Math.max(base.voices.length, 1);
  const layout = laneLayout(count);
  const capacity = pitchBufferCapacity(base.grid, layout);
  const ends = base.voices.map((voice) => lineEnds(base, voice));
  const startedAt = now();

  const feeds: Feed[] = [];
  const lanes: SingLane[] = [];
  for (let i = 0; i < count; i++) {
    const run = runs[i % Math.max(runs.length, 1)];
    const voice = i % voiceCount;
    const buffer = new PitchBuffer(capacity);
    const look =
      base.lanes.length > 0
        ? base.lanes[i % base.lanes.length]?.player
        : undefined;
    lanes.push({
      colour: PALETTE_KEYS[i % PALETTE_KEYS.length] ?? "cherry",
      voice,
      ...(look ? { player: { ...look, score: 0 } } : {}),
      trace: {
        readings: buffer,
        micThresholdDbfs: MIC_THRESHOLD.phoneFallbackDbfs,
        difficulty: "medium",
        lostAt: null,
      },
    });
    if (!run || run.readings.length === 0) continue;
    const firstMs = run.readings[0]?.[0] ?? 0;
    const lastMs = run.readings.at(-1)?.[0] ?? firstMs;
    const runMs = lastMs - firstMs + (lastMs - firstMs) / run.readings.length;
    feeds.push({
      lane: i,
      run,
      buffer,
      voice,
      startAt: startedAt + i * LANE_STAGGER_MS,
      runMs: Math.max(runMs, 1),
      firstMs,
      row: 0,
      pass: 0,
      line: 0,
      rated: i,
      reading: { captureMs: 0, pitch: null, clarity: 0, loudness: -120 },
    });
  }

  const state: SingState = {
    grid: base.grid,
    voices: base.voices,
    lanes,
    ...(base.lengthSeconds !== undefined
      ? { lengthSeconds: base.lengthSeconds }
      : {}),
    effects: new ParticlePool(EFFECTS_CAPACITY),
    ratings: new LineRatings(),
  };

  /** The next Line to end after `songTime`. */
  function nextLine(voiceEnds: Float64Array, songTime: number): number {
    let line = 0;
    while (line < voiceEnds.length && (voiceEnds[line] ?? 0) <= songTime)
      line++;
    return line;
  }

  function feed(f: Feed, elapsedTo: number) {
    const rows = f.run.readings;
    const voiceEnds = ends[f.voice] ?? new Float64Array();
    for (;;) {
      const row = rows[f.row];
      if (!row) break;
      const captureMs = f.startAt + f.pass * f.runMs + (row[0] - f.firstMs);
      if (captureMs > elapsedTo) break;
      if (++f.row === rows.length) {
        f.row = 0;
        f.pass++;
      }
      if (captureMs < elapsedTo - CATCH_UP_MS) continue;
      const songTime = placedSongTime(clock, captureMs, f.run.micDelayMs);
      if (songTime === null) continue;
      const newest = f.buffer.newestSongTime();
      if (newest !== null && songTime < newest) {
        // A Restart: Song time went back, and a buffer keeps Song-time order.
        f.buffer.clear();
        f.line = nextLine(voiceEnds, songTime);
      }
      const reading = f.reading;
      reading.captureMs = captureMs;
      reading.pitch = row[1];
      reading.clarity = row[2];
      reading.loudness = row[3];
      f.buffer.push(reading, songTime);
      while (
        f.line < voiceEnds.length &&
        (voiceEnds[f.line] ?? 0) <= songTime
      ) {
        f.line++;
        const rating = RATINGS[f.rated++ % RATINGS.length] ?? 0;
        const word = lineRatingWord(rating);
        lineEnded(state, f.lane, {
          rating,
          word: word === null ? null : LINE_RATING_KEYS[word],
        });
      }
    }
  }

  return {
    state,
    tick() {
      const at = now();
      for (const f of feeds) feed(f, at);
    },
  };
}
