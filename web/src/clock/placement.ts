/**
 * Placing Pitch readings on Song time, before they reach the scorer.
 *
 * A reading's Song time is `songTimeAt(captureTime − Mic delay)`, the same for
 * Phones, Mic bridges and Local mics read by the Stage browser: `captureTime`
 * is the reading's window-centre stamp on the Stage's clock, and every delay
 * the browser can't see sits inside the Mic delay. The A/V offset shifts only
 * what is drawn and never enters here.
 */

import type { SongClock } from "./songClock";

/** What placement reads from the Song clock. */
export type PlacementClock = Pick<
  SongClock,
  "songTimeAt" | "playingAt" | "lastSeekAt"
>;

/** A reading with the Song time it was sung at, in seconds. */
export type PlacedReading<R> = R & { songTime: number };

/**
 * Places `reading` on Song time with its Mic's `micDelayMs` (stored or
 * default for the current Stage output; the caller chooses it).
 *
 * Returns `null`, so the reading never reaches the scorer, when its moment
 * falls inside a pause, stall or resume countdown, before the latest Restart,
 * outside the Song (before playback began or after it ended), or outside the
 * clock's history.
 */
export function placeReading<R extends { captureTime: number }>(
  clock: PlacementClock,
  reading: R,
  micDelayMs: number,
): PlacedReading<R> | null {
  const songTime = placedSongTime(clock, reading.captureTime, micDelayMs);
  return songTime === null ? null : { ...reading, songTime };
}

/**
 * The Song time `placeReading` would give a reading captured at `captureTime`
 * (ms on the Stage's clock), without building a new reading: the Stage's
 * Pitch buffers place about 100 readings a second per Mic this way.
 */
export function placedSongTime(
  clock: PlacementClock,
  captureTime: number,
  micDelayMs: number,
): number | null {
  const moment = captureTime - micDelayMs;
  if (!clock.playingAt(moment)) return null;
  if (clock.lastSeekAt !== null && moment < clock.lastSeekAt) return null;
  return clock.songTimeAt(moment);
}
