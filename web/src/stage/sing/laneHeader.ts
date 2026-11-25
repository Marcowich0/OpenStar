/**
 * The lane header's sizes as a pure function of the lane height (#55, "Lane
 * header"), in the 1920 × 1080 reference frame.
 */

export interface LaneHeaderSizes {
  /** The avatar's diameter: up to 70 px, never taller than the lane minus 14 px. */
  avatar: number;
  /** The running Score's font size. */
  score: number;
}

const AVATAR_MAX = 70;
const AVATAR_MARGIN = 14;

export function laneHeaderSizes(laneHeight: number): LaneHeaderSizes {
  return {
    avatar: Math.min(AVATAR_MAX, laneHeight - AVATAR_MARGIN),
    score: laneHeight < 90 ? 28 : laneHeight < 130 ? 36 : 44,
  };
}
