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
  /** Horizontal scale of the Notes. */
  pixelsPerBeat: number;
}

/** One lane per Player, in Player order. */
export type LaneLayout = readonly LaneRect[];

/** The bottom of the lowest lane: the singing block docks above the lyric bar. */
export const LANES_BOTTOM = 872;
/** Vertical space between lanes. */
export const LANE_GAP = 10;
/** The most Players the layout has a design for. */
export const MAX_LANES = 8;

/** Lane heights for 1 to 4 Players in one column. */
const ONE_COLUMN_HEIGHTS = [170, 140, 120, 110] as const;
const ROWS = ONE_COLUMN_HEIGHTS.length;

const ONE_COLUMN = { x: 60, width: 1800, notes: 320, playhead: 600, ppb: 44 };
const TWO_COLUMNS = {
  xs: [60, 970],
  width: 890,
  notes: 210,
  playhead: 380,
  ppb: 34,
} as const;

/** The top of row `row` of `rows` rows of height `height`, docked at the bottom. */
function rowTop(row: number, rows: number, height: number): number {
  return LANES_BOTTOM - height - (rows - 1 - row) * (height + LANE_GAP);
}

/**
 * The lanes for `players` Players: one column for 1 to 4, two columns for 5
 * to 8 (Players 1 to 4 on the left, the rest on the right, row by row).
 */
export function laneLayout(players: number): LaneLayout {
  if (!Number.isInteger(players) || players < 0 || players > MAX_LANES) {
    throw new RangeError(`no lane layout for ${String(players)} Players`);
  }
  const lanes: LaneRect[] = [];
  if (players <= ROWS) {
    const height = ONE_COLUMN_HEIGHTS[players - 1] ?? 0;
    for (let i = 0; i < players; i++) {
      lanes.push({
        x: ONE_COLUMN.x,
        y: rowTop(i, players, height),
        width: ONE_COLUMN.width,
        height,
        notesX: ONE_COLUMN.notes,
        playheadX: ONE_COLUMN.playhead,
        pixelsPerBeat: ONE_COLUMN.ppb,
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
      y: rowTop(i % ROWS, ROWS, height),
      width: TWO_COLUMNS.width,
      height,
      notesX: columnX + TWO_COLUMNS.notes,
      playheadX: columnX + TWO_COLUMNS.playhead,
      pixelsPerBeat: TWO_COLUMNS.ppb,
    });
  }
  return lanes;
}
