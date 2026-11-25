/**
 * Every tunable scoring number, in one place (#54 "Constants in one place"),
 * so tuning is a one-line change. No other module restates these numbers:
 * import them from here.
 */

import type { Difficulty } from "../generated/Difficulty";

export const SCORING = {
  /** Points shared by all scored Notes of a Voice (Normal and Golden). */
  notePoints: 9000,
  /** Points shared by all scored Lines of a Voice. */
  lineBonusPoints: 1000,
  /** A Line is perfect at its maximum minus this; none for a Line worth this or less. */
  linePerfectionMargin: 2,
  /** A Line rating runs from 0 to this. */
  lineRatingScale: 8,
  /** Cents either side of the Note that still hit, the boundary included. */
  toleranceCents: { easy: 250, medium: 150, hard: 50 } satisfies Record<
    Difficulty,
    number
  >,
  /**
   * The sung pitch moves by whole octaves to within this many cents of the
   * Note, to `[−fold, +fold)`: an exact tritone folds downward.
   */
  octaveFoldCents: 600,
  /** A reading is voiced when it passes the Mic threshold and has this clarity or more. */
  voicedMinClarity: 0.8,
  /** A Beat's value is fixed this long (Song time) after the Beat ends. */
  gracePeriodMs: 300,
  /** A Mic with no readings for this long (Stage time) is lost. */
  micLostAfterMs: 1000,
  /** Width of one Rank title band, in points. */
  rankTitleBandPoints: 1250,
  /** Number of Rank title bands. */
  rankTitleBands: 8,
  /** Entries in each High score table. */
  highScoreTableLength: 10,
} as const;

/**
 * The readings out of `n` in a Beat that must be voiced (or pass the Mic
 * threshold): at least half, rounded up, minimum 1.
 */
export function readingsNeeded(n: number): number {
  return Math.max(1, Math.ceil(n / 2));
}

/** The word a Line rating shows; a key for `t()`, or `null` for none. */
export type LineRatingWord = "perfect" | "great" | "good" | "ok";

/** Line rating bands, highest first: 8 Perfect!, 6–7 Great!, 4–5 Good, 2–3 OK, 0–1 none. */
const LINE_RATING_WORDS: readonly { from: number; word: LineRatingWord }[] = [
  { from: 8, word: "perfect" },
  { from: 6, word: "great" },
  { from: 4, word: "good" },
  { from: 2, word: "ok" },
];

/** The word for a Line rating (0 … 8), or `null` when it shows none. */
export function lineRatingWord(rating: number): LineRatingWord | null {
  return LINE_RATING_WORDS.find((band) => rating >= band.from)?.word ?? null;
}
