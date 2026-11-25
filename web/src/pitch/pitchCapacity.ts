/**
 * How many readings each Player's Pitch buffer holds, fixed when the sing
 * screen starts a Song.
 *
 * A buffer must hold every reading a lane can still draw and every reading the
 * scorer has not yet finalised. Both windows end at the newest reading, so the
 * longer of the two decides.
 */

import type { BeatGrid } from "../clock/beats";
import type { LaneLayout } from "../stage/sing/laneLayout";

/** Pitch readings a Mic sends per second (about 92 measured; rounded up). */
export const READINGS_PER_SECOND = 100;
/** Headroom over the computed window: bursts, a faster Mic, rounding. */
const MARGIN = 2;
/**
 * The drawn past moves back by the A/V offset (`songTime() − avOffset`), so
 * the lanes may need this much more Song time than their width shows.
 */
const AV_OFFSET_ALLOWANCE_SECONDS = 1;
/**
 * The scorer fixes a Beat's value 300 ms of Song time after the Beat ends
 * (the grace period, #54).
 */
const GRACE_SECONDS = 0.3;
/** Readings can reach the Stage this late on Wi-Fi (worst seen about 270 ms). */
const LATE_DELIVERY_SECONDS = 0.3;

/** The capacity for a Song with Beat grid `grid` drawn in `lanes`. */
export function pitchBufferCapacity(grid: BeatGrid, lanes: LaneLayout): number {
  const beatSeconds = 60 / grid.beatsPerMinute;
  let pastBeats = 0;
  for (const lane of lanes) {
    pastBeats = Math.max(
      pastBeats,
      (lane.playheadX - lane.notesX) / lane.pixelsPerBeat,
    );
  }
  const drawnSeconds =
    lanes.length === 0
      ? 0
      : pastBeats * beatSeconds + AV_OFFSET_ALLOWANCE_SECONDS;
  const unfinalisedSeconds =
    beatSeconds + GRACE_SECONDS + LATE_DELIVERY_SECONDS;
  const seconds = Math.max(drawnSeconds, unfinalisedSeconds);
  // Less a hair, so a whole count off by floating point (0.85 × 200) stays put.
  return Math.ceil(seconds * READINGS_PER_SECOND * MARGIN - 1e-9);
}
