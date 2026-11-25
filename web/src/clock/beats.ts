/**
 * Beats over Song time: a pure function of the parsed Song's `#GAP` and `#BPM`.
 *
 * The clock never knows about Beats, so a Timing edit (a new `GAP` or `BPM`)
 * changes Beats without touching the clock. The scorer collects each Beat's
 * Pitch readings with these boundaries, and the Timing editor reuses them.
 */

import type { SongHeaders } from "../generated/SongHeaders";

/**
 * The parsed Song's timing, with units normalised by the parser:
 * `gapSeconds` = `#GAP` / 1000 and `beatsPerMinute` = `#BPM` × 4, so one Beat
 * lasts `60 / beatsPerMinute` = `15 / #BPM` seconds.
 */
export type BeatGrid = Pick<SongHeaders, "gapSeconds" | "beatsPerMinute">;

/** Song time (seconds) at which Beat `beat` starts. */
export function beatStart(song: BeatGrid, beat: number): number {
  return song.gapSeconds + (beat * 60) / song.beatsPerMinute;
}

/**
 * The Beat covering Song time `t` (seconds): Beat b covers
 * `[beatStart(b), beatStart(b + 1))`, so a time exactly on a boundary belongs
 * to the later Beat. Times before `GAP` give negative Beats.
 */
export function beatAt(song: BeatGrid, t: number): number {
  let beat = Math.floor(((t - song.gapSeconds) * song.beatsPerMinute) / 60);
  // The division above can land one Beat off right at a boundary; settle it
  // against `beatStart`, so both functions agree exactly.
  if (beatStart(song, beat) > t) beat -= 1;
  else if (beatStart(song, beat + 1) <= t) beat += 1;
  return beat;
}

/**
 * The boundaries of Beats `first` to `last` (inclusive): their starts plus the
 * end of `last`, so Beat `first + i` covers `[result[i], result[i + 1])`.
 */
export function beatBoundaries(
  song: BeatGrid,
  first: number,
  last: number,
): number[] {
  const boundaries: number[] = [];
  for (let beat = first; beat <= last + 1; beat++) {
    boundaries.push(beatStart(song, beat));
  }
  return boundaries;
}
