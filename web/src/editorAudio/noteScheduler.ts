/**
 * The Timing editor's clicks and hums (v1 spec #57, "Checking by ear",
 * ticket #220), as a pure scheduler.
 *
 * `noteSounds` lists what the Notes sound like: a click on every Note start
 * (an accent on a Golden note, Golden rap included) and, optionally, a hum at
 * each Normal or Golden note's pitch for its length (never for Rap, Golden
 * rap or Freestyle notes).
 *
 * `createNoteScheduler` hands them to a sink ahead of time: every 30 ms it
 * tops up the sounds that start within about 250 ms of Song time (scaled by
 * the rate) of `songTime()`, each start and end mapped from Song time to the
 * Stage clock along the clock's rate and from there to `AudioContext` time
 * through the shared mapping (`contextTimeAt`, the inverse of
 * `outputTime`). `reset()` drops everything scheduled and starts again from
 * the current Song time: the editor calls it after every seek and speed
 * change, and `setSounds` does it after every edit. Stopping playback drops
 * everything too.
 *
 * The sounds play through the same output path as the Song, so they need no
 * A/V offset: the offset shifts the drawing only.
 */

import type { BeatGrid } from "../clock/beats";
import type { NoteKind } from "../generated/NoteKind";
import type { Note } from "../generated/Note";
import { noteTimes } from "../timing/timingModel";

export const NOTE_SOUNDS = {
  /** Sounds are scheduled this far ahead, seconds of Song time at rate 1. */
  lookaheadSeconds: 0.25,
  /** How often the scheduler tops up, ms. */
  topUpMs: 30,
} as const;

/** One sound, in seconds of Song time. */
export type NoteSound =
  | { kind: "click" | "accent"; at: number; end: number }
  | { kind: "hum"; at: number; end: number; hz: number };

/** Whether the clicks and the hum are on. */
export interface NoteSoundChoice {
  clicks: boolean;
  hum: boolean;
}

/** The part of a Song the sounds come from. */
export interface SoundingSong {
  voices: readonly {
    lines: readonly { notes: readonly Note[] }[];
  }[];
}

const GOLDEN: ReadonlySet<NoteKind> = new Set(["golden", "goldenRap"]);
const HUMMED: ReadonlySet<NoteKind> = new Set(["normal", "golden"]);

/** A Note's pitch (semitones from C4) in Hz: pitch 9 is A4, 440 Hz. */
function pitchHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 9) / 12);
}

/** The sounds of every Voice's Notes, in time order. */
export function noteSounds(
  song: SoundingSong,
  grid: BeatGrid,
  { clicks, hum }: NoteSoundChoice,
): NoteSound[] {
  const sounds: NoteSound[] = [];
  for (const voice of song.voices)
    for (const line of voice.lines)
      for (const note of line.notes) {
        const { start, end } = noteTimes(grid, note);
        if (clicks)
          sounds.push({
            kind: GOLDEN.has(note.kind) ? "accent" : "click",
            at: start,
            end: start,
          });
        if (hum && HUMMED.has(note.kind))
          sounds.push({ kind: "hum", at: start, end, hz: pitchHz(note.pitch) });
      }
  return sounds.sort((a, b) => a.at - b.at);
}

/** The part of the Song clock the scheduler reads. */
export interface SchedulerClock {
  songTime(): number;
  readonly rate: number;
  readonly playing: boolean;
}

/** Plays a sound from `start` to `end` (AudioContext seconds); returns its cancel. */
export interface SoundSink {
  play(sound: NoteSound, start: number, end: number): () => void;
}

/** A repeating timer; returns its cancel. Tests drive it by hand. */
export interface SchedulerTimer {
  every(ms: number, callback: () => void): () => void;
}

const browserTimer: SchedulerTimer = {
  every(ms, callback) {
    const handle = window.setInterval(callback, ms);
    return () => {
      window.clearInterval(handle);
    };
  },
};

export interface NoteSchedulerOptions {
  clock: SchedulerClock;
  /** The Stage clock, ms. */
  now?: () => number;
  /** The shared mapping: the AudioContext time heard at a Stage time (ms). */
  contextTimeAt: (stageMs: number) => number | null;
  sink: SoundSink;
  timer?: SchedulerTimer;
}

export interface NoteScheduler {
  /** New sounds (an edit, or clicks or hum switched): reschedules them all. */
  setSounds(sounds: readonly NoteSound[]): void;
  /** Drops everything scheduled; the next top-up starts from Song time now. */
  reset(): void;
  /** Stops topping up and drops everything scheduled. */
  stop(): void;
}

export function createNoteScheduler({
  clock,
  now = () => performance.now(),
  contextTimeAt,
  sink,
  timer = browserTimer,
}: NoteSchedulerOptions): NoteScheduler {
  let sounds: readonly NoteSound[] = [];
  /** Song time up to which sounds are scheduled; `null`: nothing is. */
  let scheduledUntil: number | null = null;
  let scheduled: { end: number; cancel: () => void }[] = [];

  function reset() {
    for (const { cancel } of scheduled) cancel();
    scheduled = [];
    scheduledUntil = null;
  }

  function topUp() {
    if (!clock.playing) {
      if (scheduledUntil !== null) reset();
      return;
    }
    const at = now();
    const songTime = clock.songTime();
    const rate = clock.rate;
    if (rate <= 0) return;
    // What has played is no longer anything to drop.
    scheduled = scheduled.filter((s) => s.end >= songTime);
    const from = scheduledUntil ?? songTime;
    const until = songTime + NOTE_SOUNDS.lookaheadSeconds * rate;
    if (until <= from) return;
    const contextAt = (t: number) =>
      contextTimeAt(at + ((t - songTime) / rate) * 1000);
    for (const sound of sounds) {
      if (sound.at < from) continue;
      if (sound.at >= until) break;
      const start = contextAt(sound.at);
      const end = contextAt(sound.end);
      if (start === null || end === null) {
        // No output reported yet: carry on from here on the next top-up.
        scheduledUntil = sound.at;
        return;
      }
      scheduled.push({ end: sound.end, cancel: sink.play(sound, start, end) });
    }
    scheduledUntil = until;
  }

  const cancelTimer = timer.every(NOTE_SOUNDS.topUpMs, topUp);

  return {
    setSounds(next) {
      sounds = [...next].sort((a, b) => a.at - b.at);
      reset();
    },
    reset,
    stop() {
      cancelTimer();
      reset();
    },
  };
}
