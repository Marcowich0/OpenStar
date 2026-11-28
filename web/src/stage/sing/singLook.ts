/**
 * The sing screen's look from the Stage options: the lyric bar's size, its
 * next Line and the lane panels' frosting. The bar and the panels are DOM
 * (for the backdrop blur), but their numbers live here, so `frame()` puts
 * them in the draw list and the DOM reads the same functions: a test of the
 * draw list is a test of what shows.
 *
 * Sizes are in the 1920 × 1080 reference frame; `m` is #55's.
 */

import type { CSSProperties } from "react";

import type { LyricSize } from "../../generated/LyricSize";
import type { StageOptions } from "../../generated/StageOptions";
import { THEMES, type SingTheme } from "../../theme/themes";
import { tokenVar, type TokenName } from "../../theme/tokens";
import type { SingState } from "./frame";
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

/** Whether two looks are the same, option by option. */
export function sameLook(a: SingLook, b: SingLook): boolean {
  return (Object.keys(DEFAULT_SING_LOOK) as (keyof SingLook)[]).every(
    (option) => a[option] === b[option],
  );
}

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
  /** The bar's background; its alpha and blur are the theme's. */
  fill: "--color-surface",
  radius: 52,
} as const;

/** The frame's height. */
const FRAME_HEIGHT = 1080;
/** The least space kept between the lowest lane and the lyric bar. */
const LANES_ABOVE_BAR = 12;

/** Bubble Pop's sing screen, for a frame drawn with no theme. */
export const DEFAULT_SING_THEME: SingTheme = THEMES.bubblePop.sing;

/** A surface's flat fill: a token at an alpha, over a backdrop blurred by `blur` px. */
export interface SurfaceFill {
  colour: TokenName;
  alpha: number;
  /** 0: no backdrop blur. */
  blur: number;
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

/** The lyric bar for `look` on a Song of `voices` Voices, in `theme`. */
export function lyricBarBox(
  look: SingLook,
  voices: number,
  theme: SingTheme = DEFAULT_SING_THEME,
): LyricBarBox {
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
    fill: {
      colour: LYRIC_BAR.fill,
      alpha: theme.lyricBar.alpha,
      blur: theme.lyricBar.blur,
    },
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

/**
 * A DOM surface's style for `fill`: its colour mixed to its alpha in
 * `space`, over the backdrop blurred by its blur (then `filter`, such as a
 * saturation), or no backdrop filter at all without a blur.
 */
export function surfaceFillStyle(
  fill: SurfaceFill,
  space: "oklab" | "srgb",
  filter = "",
): Pick<
  CSSProperties,
  "backgroundColor" | "backdropFilter" | "WebkitBackdropFilter"
> {
  const backdrop =
    fill.blur > 0
      ? [`blur(${String(fill.blur)}px)`, filter].filter(Boolean).join(" ")
      : "none";
  return {
    backgroundColor: `color-mix(in ${space}, ${tokenVar(fill.colour)} ${String(Math.round(fill.alpha * 100))}%, transparent)`,
    backdropFilter: backdrop,
    WebkitBackdropFilter: backdrop,
  };
}

/**
 * The lane panels' fill, in the theme's surface colour (white in Bubble
 * Pop): frosted at the Lane frosting option, or solid in a theme with solid
 * lanes (High contrast), whatever the option says.
 */
export function laneFill(
  look: SingLook,
  theme: SingTheme = DEFAULT_SING_THEME,
): SurfaceFill {
  return theme.lanes === "solid"
    ? { colour: "--color-surface", alpha: 1, blur: 0 }
    : {
        colour: "--color-surface",
        alpha: look.laneFrostingPercent / 100,
        blur: theme.laneBlur,
      };
}

/**
 * What the lanes' layout reads of a sing state: how many lanes, how many
 * Voices (a duet's lyric bar is taller) and the look.
 */
export type SingLayoutInput = Pick<SingState, "lanes" | "voices" | "look">;

/** The lanes for a sing state: one per Player, above its lyric bar. */
export function singLayout(state: SingLayoutInput): LaneLayout {
  return laneLayout(
    state.lanes.length,
    DEFAULT_NOTE_SPEED,
    lanesBottom(state.look ?? DEFAULT_SING_LOOK, state.voices.length),
  );
}
