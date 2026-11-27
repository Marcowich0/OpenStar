/**
 * Where each Player's lane sits on the sing screen, computed from the Player
 * count (never from the v1 seat count), in the 1920 × 1080 reference frame of
 * #55. Lanes above 8 are designed when that feature is built.
 */

export interface LaneRect {
  /** Left edge of the lane panel. */
  x: number;
  /** Top edge of the lane panel. */
  y: number;
  width: number;
  height: number;
  /** Where the Notes area starts (left of it is the lane header). */
  notesX: number;
  /** The fixed playhead Notes scroll past. */
  playheadX: number;
  /**
   * Horizontal scale of the Notes, in px per second of Song time. It is set
   * by time, never by Beat, so a fast Song scrolls no faster than a slow one:
   * see {@link NOTE_SPEED_LOOKAHEAD_SECONDS}.
   */
  pixelsPerSecond: number;
}

/** How fast the Notes scroll past the playhead. */
export type NoteSpeed = "slow" | "normal" | "fast";

/**
 * Seconds of upcoming Song a one-column lane shows between its playhead and
 * its right edge, for each Note speed. This one table sets the scroll speed
 * of every lane; a user setting picks the key.
 *
 * v1 scrolled at a fixed 44 px per Beat, so the speed grew with `#BPM`: a
 * typical `#BPM:300` file scrolled at 880 px/s and showed 1.4 s ahead. Normal
 * now shows 3 s ahead at 420 px/s, whatever the `#BPM`.
 */
export const NOTE_SPEED_LOOKAHEAD_SECONDS: Readonly<Record<NoteSpeed, number>> =
  {
    slow: 4,
    normal: 3,
    fast: 2,
  };

export const DEFAULT_NOTE_SPEED: NoteSpeed = "normal";

/** One lane per Player, in Player order. */
export type LaneLayout = readonly LaneRect[];

/**
 * The bottom of the lowest lane at #55's lyric bar: the singing block docks
 * above it. A larger lyric bar docks it higher (`lanesBottom` in `singLook`).
 */
export const LANES_BOTTOM = 872;
/** Vertical space between lanes. */
export const LANE_GAP = 10;
/** The most Players the layout has a design for. */
export const MAX_LANES = 8;

/** Lane heights for 1 to 4 Players in one column. */
const ONE_COLUMN_HEIGHTS = [170, 140, 120, 110] as const;
const ROWS = ONE_COLUMN_HEIGHTS.length;

const ONE_COLUMN = { x: 60, width: 1800, notes: 320, playhead: 600 };
const TWO_COLUMNS = {
  xs: [60, 970],
  width: 890,
  notes: 210,
  playhead: 380,
} as const;
/**
 * Two-column lanes scroll at this share of the one-column speed (#55's 34
 * against 44 px per Beat). Their shorter Notes area then shows about half the
 * one-column lookahead (1.6 s at normal), so Notes stay wide enough to read.
 */
const TWO_COLUMN_SCALE = 34 / 44;

/** The top of row `row` of `rows` rows of height `height`, docked at `bottom`. */
function rowTop(
  row: number,
  rows: number,
  height: number,
  bottom: number,
): number {
  return bottom - height - (rows - 1 - row) * (height + LANE_GAP);
}

/**
 * The lanes for `players` Players: one column for 1 to 4, two columns for 5
 * to 8 (Players 1 to 4 on the left, the rest on the right, row by row), with
 * the Notes scrolling at `speed`, the lowest lane ending at `bottom`.
 */
export function laneLayout(
  players: number,
  speed: NoteSpeed = DEFAULT_NOTE_SPEED,
  bottom: number = LANES_BOTTOM,
): LaneLayout {
  if (!Number.isInteger(players) || players < 0 || players > MAX_LANES) {
    throw new RangeError(`no lane layout for ${String(players)} Players`);
  }
  const pixelsPerSecond =
    (ONE_COLUMN.x + ONE_COLUMN.width - ONE_COLUMN.playhead) /
    NOTE_SPEED_LOOKAHEAD_SECONDS[speed];
  const lanes: LaneRect[] = [];
  if (players <= ROWS) {
    const height = ONE_COLUMN_HEIGHTS[players - 1] ?? 0;
    for (let i = 0; i < players; i++) {
      lanes.push({
        x: ONE_COLUMN.x,
        y: rowTop(i, players, height, bottom),
        width: ONE_COLUMN.width,
        height,
        notesX: ONE_COLUMN.notes,
        playheadX: ONE_COLUMN.playhead,
        pixelsPerSecond,
      });
    }
    return lanes;
  }
  // Two columns keep the 4-row height.
  const height = ONE_COLUMN_HEIGHTS[3];
  for (let i = 0; i < players; i++) {
    const columnX = TWO_COLUMNS.xs[i < ROWS ? 0 : 1];
    lanes.push({
      x: columnX,
      y: rowTop(i % ROWS, ROWS, height, bottom),
      width: TWO_COLUMNS.width,
      height,
      notesX: columnX + TWO_COLUMNS.notes,
      playheadX: columnX + TWO_COLUMNS.playhead,
      pixelsPerSecond: pixelsPerSecond * TWO_COLUMN_SCALE,
    });
  }
  return lanes;
}
