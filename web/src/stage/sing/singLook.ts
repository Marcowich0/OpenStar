/**
 * The sing screen's look from the Stage options: the lyric bar's size, its
 * next Line and the lane panels' frosting. The bar and the panels are DOM
 * (for the backdrop blur), but their numbers live here, so `frame()` puts
 * them in the draw list and the DOM reads the same functions: a test of the
 * draw list is a test of what shows.
 *
 * Sizes are in the 1920 × 1080 reference frame; `m` is #55's.
 */

import type { LyricSize } from "../../generated/LyricSize";
import type { StageOptions } from "../../generated/StageOptions";
import type { TokenName } from "../../theme/tokens";
import {
  DEFAULT_NOTE_SPEED,
  LANES_BOTTOM,
  laneLayout,
  type LaneLayout,
} from "./laneLayout";

/** The Stage options the sing screen's look takes, fixed at a Song's Start. */
export type SingLook = Pick<
  StageOptions,
  "lyricSize" | "showNextLine" | "laneFrostingPercent"
>;

/** The look before the options existed. */
export const DEFAULT_SING_LOOK: SingLook = {
  lyricSize: "m",
  showNextLine: true,
  laneFrostingPercent: 66,
};

/** Each Lyric size's text, as a share of `m`'s. */
export const LYRIC_SCALE: Readonly<Record<LyricSize, number>> = {
  s: 0.8,
  m: 1,
  l: 1.25,
  xl: 1.5,
};

/** The lyric bar at `m` (#55, #215). */
export const LYRIC_BAR = {
  /** One Voice's current Line. */
  lineSize: 78,
  /** Each Voice's current Line in a duet. */
  duetLineSize: 60,
  /** The next Line, under the current one. */
  nextSize: 36,
  /** Line height, as a share of the text size. */
  lineHeight: 1.1,
  paddingTop: 10,
  paddingBottom: 16,
  paddingInline: 60,
  /** From the bar's bottom edge to the bottom of the frame; the bar grows up from here. */
  bottomGap: 34,
  /** The bar's frosted background. */
  fill: { colour: "--color-white", alpha: 0.86 },
  blur: 14,
  radius: 52,
} as const;

/** The frame's height. */
const FRAME_HEIGHT = 1080;
/** The least space kept between the lowest lane and the lyric bar. */
const LANES_ABOVE_BAR = 12;

/** A surface's flat fill: a token at an alpha. */
export interface SurfaceFill {
  colour: TokenName;
  alpha: number;
}

/** The lyric bar's box at its tallest, which the lanes stay above. */
export interface LyricBarBox {
  top: number;
  /** Fixed: the bar grows upward. */
  bottom: number;
  height: number;
  /** How many current Lines show: one, or one per Voice in a duet. */
  lines: number;
  /** Text size of each current Line, px. */
  lineSize: number;
  /** Text size of the next Line, px; `null`: no next Line shows. */
  nextSize: number | null;
  fill: SurfaceFill;
}

/** The lyric bar for `look` on a Song of `voices` Voices. */
export function lyricBarBox(look: SingLook, voices: number): LyricBarBox {
  const scale = LYRIC_SCALE[look.lyricSize];
  const duet = voices > 1;
  const lines = duet ? 2 : 1;
  const lineSize = (duet ? LYRIC_BAR.duetLineSize : LYRIC_BAR.lineSize) * scale;
  const nextSize =
    !duet && look.showNextLine ? LYRIC_BAR.nextSize * scale : null;
  const height =
    LYRIC_BAR.paddingTop +
    (lines * lineSize + (nextSize ?? 0)) * LYRIC_BAR.lineHeight +
    LYRIC_BAR.paddingBottom;
  const bottom = FRAME_HEIGHT - LYRIC_BAR.bottomGap;
  return {
    top: bottom - height,
    bottom,
    height,
    lines,
    lineSize,
    nextSize,
    fill: LYRIC_BAR.fill,
  };
}

/**
 * The bottom of the lowest lane: #55's, or higher when the lyric bar would
 * reach it, so a larger bar moves the lanes up instead of covering them.
 */
export function lanesBottom(look: SingLook, voices: number): number {
  const bar = lyricBarBox(look, voices);
  return Math.min(LANES_BOTTOM, Math.floor(bar.top - LANES_ABOVE_BAR));
}

/** The lane panels' white frosting. */
export function laneFill(look: SingLook): SurfaceFill {
  return { colour: "--color-white", alpha: look.laneFrostingPercent / 100 };
}

/** What the sing screen's layout depends on. */
export interface LaidOut {
  lanes: readonly unknown[];
  voices: readonly unknown[];
  look?: SingLook;
}

/** The lanes for a sing state: one per Player, above its lyric bar. */
export function singLayout(state: LaidOut): LaneLayout {
  return laneLayout(
    state.lanes.length,
    DEFAULT_NOTE_SPEED,
    lanesBottom(state.look ?? DEFAULT_SING_LOOK, state.voices.length),
  );
}
