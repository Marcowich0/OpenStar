/**
 * Live scoring on the Stage (#165): one scoring session per Song, judging
 * every seated Player's Beats while the Song plays.
 *
 * At Start the session takes each Player's Voice, Difficulty, Mic kind,
 * Mic delay and effective Mic threshold once; they stay fixed for the Song.
 * Readings reach it through the Player's ring buffer, placed on Song time by
 * the session's own `placement` (`songTimeAt(captureTime − Mic delay)` with
 * that Player's Mic delay), so readings the clock drops (in a pause, before a
 * Restart, outside the Song) never reach a Beat.
 *
 * Each `tick()` reads Song time once through `songTime()` and finalises every
 * Beat whose end plus the grace period (300 ms of Song time) it has reached:
 * the Beat's value is computed once from the readings in its span
 * (`beatValue`), stored, and judged by the Player's incremental scorer. A
 * reading that arrives later is still drawn but never scores. A pause freezes
 * Song time, so Beats waiting for their grace period stay open across it.
 *
 * The lost-Mic rule runs per seat (`createMicWatch`, Stage time): a Beat
 * during which a tick saw the seat's Mic lost counts as no voice, and the
 * seat's mic lost flag is the rule's "lost at any moment" since the Song
 * (re)started. Restart (`reset`) forgets everything of the Song so far.
 *
 * When the Song ends, `outcome()` gives what a Score record needs per Player.
 * A batch run (`scoreBeats`) over its Beat values gives the same Score as the
 * live run whenever the Song did not end inside a scored Line; see
 * `PlayerOutcome.beatValues`.
 */

import { beatAt, beatStart } from "../clock/beats";
import type { PlacementClock } from "../clock/placement";
import type { SongClock } from "../clock/songClock";
import type { BeatValue } from "../generated/BeatValue";
import type { Difficulty } from "../generated/Difficulty";
import type { MicKind } from "../generated/MicKind";
import type { NoteFingerprint } from "../generated/NoteFingerprint";
import type { ParsedSong } from "../generated/ParsedSong";
import type { PitchBuffer, PitchReadingVisitor } from "../pitch/pitchBuffer";
import { clockPlacement, type Placement } from "../pitch/pitchRouter";
import { beatValue, type BeatReading } from "./beatValues";
import { SCORING } from "./constants";
import { createMicWatch, type MicEvent, type MicWatch } from "./micLost";
import {
  createScorer,
  type BeatRange,
  type LineResult,
  type Score,
  type Scorer,
  type ScoreSums,
} from "./scorer";

/** One seated Player's inputs, taken once at Start. */
export interface LiveScoringPlayer {
  /** Index into the parsed Song's `voices` (0 = `P1`). */
  voice: number;
  difficulty: Difficulty;
  micKind: MicKind;
  /** The Mic delay that places this Player's readings, ms. */
  micDelayMs: number;
  /** The effective Mic threshold, dBFS. */
  micThresholdDbfs: number;
}

export interface LiveScoringOptions {
  /** The parsed Song as loaded. */
  song: Pick<ParsedSong, "headers" | "voices">;
  /** The loaded Song's Note fingerprint, returned with the outcome. */
  noteFingerprint: NoteFingerprint;
  /** One per seat, in seat order. */
  players: readonly LiveScoringPlayer[];
  /** The Song clock: Song time through `songTime()`, placement through `songTimeAt`. */
  clock: Pick<SongClock, "songTime"> & PlacementClock;
  /** The Players' ring buffers, one per Player in Player order. */
  buffers: () => readonly PitchBuffer[];
  /** Stage time in ms (`performance.now()`), for the lost-Mic rule. */
  now?: () => number;
}

/** What changed for one Player in one tick. */
export interface LiveScoringChange {
  player: number;
  /** The running total and parts. */
  score: Score;
  /** Scored Lines that ended in this tick, in order. */
  lineEnds: readonly LineResult[];
  /** Whether the seat's Mic is lost now. */
  lost: boolean;
}

/** One Player's part of a Song's outcome: what a Score record needs. */
export interface PlayerOutcome {
  voice: number;
  difficulty: Difficulty;
  micKind: MicKind;
  beatRange: BeatRange;
  /**
   * The value of every Beat of `beatRange`, in order. Beats the Song ended
   * before finalising are no voice; the live run never judged them, so a
   * Line they belong to gave no bonus live (a batch run over these values
   * would end that Line).
   */
  beatValues: BeatValue[];
  /** The three unrounded sums. */
  sums: ScoreSums;
  /** The total and its adjusted parts. */
  score: Score;
  finished: boolean;
  micLost: boolean;
  /** Every scored Line that ended, in order. */
  lineResults: LineResult[];
}

export interface LiveScoringOutcome {
  noteFingerprint: NoteFingerprint;
  players: PlayerOutcome[];
}

export interface LiveScoring {
  /** The inputs taken at Start (copies; they never change). */
  readonly players: readonly Readonly<LiveScoringPlayer>[];
  /** Places Player `player`'s readings on Song time (`PitchSession.place`). */
  readonly placement: Placement;
  /** Finalises every Beat whose grace period has passed; call once per frame. */
  tick(): void;
  /** Something the Stage learned about a seat's Mic, at Stage time `at` (default now). */
  micEvent(player: number, kind: MicEvent["kind"], at?: number): void;
  score(player: number): Score;
  lineResults(player: number): readonly LineResult[];
  /** Whether the seat's Mic was lost at the last tick. */
  lost(player: number): boolean;
  /** Raised once per changed Player after a tick that changed them. */
  onChange(listener: (change: LiveScoringChange) => void): () => void;
  /** Restart: discards every Beat value, sum, Line result and mic lost flag. */
  reset(): void;
  /** The Song ended: finalises what is due, then each Player's outcome. */
  outcome(): LiveScoringOutcome;
}

/** One Player's running state. */
interface Seat {
  input: Readonly<LiveScoringPlayer>;
  scorer: Scorer;
  range: BeatRange;
  /** Values of the Beats of the range, filled as they are finalised. */
  values: BeatValue[];
  /** 1 where a tick saw the Mic lost during that Beat of the range. */
  lostBeats: Uint8Array;
  /** The next Beat to finalise. */
  next: number;
  watch: MicWatch;
  lost: boolean;
  /** The Beat of the last tick that saw the Mic lost, or null. */
  lostFromBeat: number | null;
}

const NO_VOICE: BeatValue = { kind: "noVoice" };

export function createLiveScoring(options: LiveScoringOptions): LiveScoring {
  const { song, clock } = options;
  const grid = song.headers;
  const now = options.now ?? (() => performance.now());
  const graceSeconds = SCORING.gracePeriodMs / 1000;
  const players = options.players.map((p) => Object.freeze({ ...p }));
  const listeners = new Set<(change: LiveScoringChange) => void>();

  const seats: Seat[] = players.map((input) => {
    const scorer = createScorer({
      voice: song.voices[input.voice] ?? { lines: [] },
      headers: grid,
      difficulty: input.difficulty,
    });
    const range = scorer.range;
    const size = Math.max(range.lastBeat - range.firstBeat + 1, 0);
    return {
      input,
      scorer,
      range,
      values: [],
      lostBeats: new Uint8Array(size),
      next: range.firstBeat,
      watch: createMicWatch(now()),
      lost: false,
      lostFromBeat: null,
    };
  });

  // The readings of the Beat being finalised, gathered without allocating
  // once the pool has grown to a Beat's worth.
  const pool: BeatReading[] = [];
  const gathered: BeatReading[] = [];
  let spanEnd = 0;
  const gather: PitchReadingVisitor = (songTime, pitch, clarity, loudness) => {
    if (songTime >= spanEnd) return;
    let reading = pool[gathered.length];
    if (!reading) {
      reading = { songTime, pitch, clarity, loudness };
      pool.push(reading);
    } else {
      reading.songTime = songTime;
      reading.pitch = pitch;
      reading.clarity = clarity;
      reading.loudness = loudness;
    }
    gathered.push(reading);
  };

  function valueOf(seat: Seat, buffer: PitchBuffer | undefined, beat: number) {
    if (seat.lostBeats[beat - seat.range.firstBeat] === 1) return NO_VOICE;
    if (!buffer) return NO_VOICE;
    gathered.length = 0;
    spanEnd = beatStart(grid, beat + 1);
    buffer.forEachFrom(beatStart(grid, beat), gather);
    return beatValue(gathered, seat.input.micThresholdDbfs);
  }

  function markLost(seat: Seat, songTime: number) {
    const beat = beatAt(grid, songTime);
    const from = seat.lostFromBeat ?? beat;
    const { firstBeat, lastBeat } = seat.range;
    for (
      let b = Math.max(from, firstBeat);
      b <= Math.min(beat, lastBeat);
      b++
    ) {
      seat.lostBeats[b - firstBeat] = 1;
    }
    seat.lostFromBeat = beat;
  }

  function tick() {
    const songTime = clock.songTime();
    const stageTime = now();
    const buffers = options.buffers();
    seats.forEach((seat, index) => {
      const lost = seat.watch.lostAt(stageTime);
      const lostChanged = lost !== seat.lost;
      seat.lost = lost;
      if (lost) markLost(seat, songTime);
      else seat.lostFromBeat = null;

      let lineEnds: LineResult[] | null = null;
      let judged = false;
      const buffer = buffers[index];
      for (
        ;
        seat.next <= seat.range.lastBeat &&
        beatStart(grid, seat.next + 1) + graceSeconds <= songTime;
        seat.next++
      ) {
        const value = valueOf(seat, buffer, seat.next);
        seat.values.push(value);
        const judgement = seat.scorer.judge(seat.next, value);
        judged ||= judgement.judged;
        if (judgement.lineEnds.length > 0) {
          (lineEnds ??= []).push(...judgement.lineEnds);
        }
      }
      if ((judged || lineEnds || lostChanged) && listeners.size > 0) {
        const change: LiveScoringChange = {
          player: index,
          score: seat.scorer.score(),
          lineEnds: lineEnds ?? [],
          lost,
        };
        for (const listener of [...listeners]) listener(change);
      }
    });
  }

  function seat(player: number): Seat {
    const found = seats[player];
    if (!found) throw new RangeError(`No Player ${String(player)}`);
    return found;
  }

  return {
    players,
    placement: clockPlacement(clock, (p) => players[p]?.micDelayMs ?? 0),
    tick,
    micEvent(player, kind, at = now()) {
      seat(player).watch.event(kind, at);
    },
    score: (player) => seat(player).scorer.score(),
    lineResults: (player) => seat(player).scorer.lineResults(),
    lost: (player) => seat(player).lost,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      const since = now();
      for (const s of seats) {
        s.scorer.reset();
        s.values = [];
        s.lostBeats.fill(0);
        s.next = s.range.firstBeat;
        s.watch = createMicWatch(since);
        s.lost = false;
        s.lostFromBeat = null;
      }
      seats.forEach((s, index) => {
        const change: LiveScoringChange = {
          player: index,
          score: s.scorer.score(),
          lineEnds: [],
          lost: false,
        };
        for (const listener of [...listeners]) listener(change);
      });
    },
    outcome() {
      tick();
      const songTime = clock.songTime();
      const stageTime = now();
      return {
        noteFingerprint: options.noteFingerprint,
        players: seats.map((s) => {
          const size = s.lostBeats.length;
          const beatValues = s.values.slice(0, size);
          while (beatValues.length < size) beatValues.push(NO_VOICE);
          return {
            voice: s.input.voice,
            difficulty: s.input.difficulty,
            micKind: s.input.micKind,
            beatRange: { ...s.range },
            beatValues,
            sums: s.scorer.sums(),
            score: s.scorer.score(),
            finished: s.scorer.isFinished(songTime),
            micLost: s.watch.lostSinceAt(stageTime),
            lineResults: s.scorer.lineResults(),
          };
        }),
      };
    },
  };
}
