/**
 * The Intro and Skip intro: where a Song's singing starts, and where Skip
 * intro (a Song control) or the Stage option "Skip long intros" lands.
 *
 * A Song's Intro runs from where it starts playing (`#START`) to the first
 * Note of the Voices its Line-up sings. Only an Intro of at least
 * `INTRO_SKIP.minIntroSeconds` counts; skipping it lands
 * `INTRO_SKIP.leadInSeconds` before that first Note, so the first Line shows
 * before it is sung. Nothing is sung in an Intro, so skipping it leaves the
 * Score untouched: a skipped Song can still be Finished.
 *
 * The Stage decides with `introEnd` and reports the landing spot to every
 * Remote (`SongProgress.introEndSeconds`); both offer Skip intro with
 * `offersSkipIntro`.
 */

import { beatStart } from "../clock/beats";
import type { ParsedSong } from "../generated/ParsedSong";

export const INTRO_SKIP = {
  /** Skip intro lands this long before the first Note. */
  leadInSeconds: 3,
  /** From `#START` to the first Note: shorter is no Intro worth skipping. */
  minIntroSeconds: 10,
  /** The button goes this long before the landing spot: nothing worth skipping is left. */
  hideBeforeSeconds: 1,
} as const;

/**
 * Song time (seconds) of the first Note of Voices `voices` (indices into
 * `song.voices`), or `null` when they have none. Every Note counts, a
 * Freestyle note too: its lyric shows.
 */
export function firstNoteSeconds(
  song: ParsedSong,
  voices: readonly number[],
): number | null {
  let first: number | null = null;
  for (const index of voices) {
    for (const line of song.voices[index]?.lines ?? []) {
      for (const note of line.notes) {
        if (first === null || note.start < first) first = note.start;
      }
    }
  }
  return first === null ? null : beatStart(song.headers, first);
}

export interface IntroInput {
  song: ParsedSong;
  /** The Voices the Line-up sings. */
  voices: readonly number[];
  /** Where the Song starts playing (`#START`), seconds. */
  startSeconds: number;
  /** Where it stops (`#END`), seconds, or `null` at the end of its audio. */
  endSeconds: number | null;
}

/**
 * Where Skip intro lands, seconds: `leadInSeconds` before the first Note.
 * `null` when the Song has no Intro of at least `minIntroSeconds` (or its
 * first Note is past where it stops).
 */
export function introEnd({
  song,
  voices,
  startSeconds,
  endSeconds,
}: IntroInput): number | null {
  const first = firstNoteSeconds(song, voices);
  if (first === null) return null;
  if (first - startSeconds < INTRO_SKIP.minIntroSeconds) return null;
  if (endSeconds !== null && first >= endSeconds) return null;
  return first - INTRO_SKIP.leadInSeconds;
}

/**
 * Whether Skip intro is offered at Song time `songSeconds`, for a Song whose
 * Intro ends at `introEndSeconds` (`null`: none): up to
 * `hideBeforeSeconds` before it.
 */
export function offersSkipIntro(
  introEndSeconds: number | null,
  songSeconds: number,
): boolean {
  return (
    introEndSeconds !== null &&
    songSeconds < introEndSeconds - INTRO_SKIP.hideBeforeSeconds
  );
}

/** Whole seconds until the singing starts (the first Note), from `songSeconds`. */
export function secondsToSinging(
  introEndSeconds: number,
  songSeconds: number,
): number {
  return Math.max(
    0,
    Math.ceil(introEndSeconds + INTRO_SKIP.leadInSeconds - songSeconds),
  );
}
