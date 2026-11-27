/**
 * The sing screen's top band (#264, decided in #242 and #240): the title
 * card, the pause hint and the time left. This changes #55's rule that the
 * top of the screen stays clear video: these three are all that sits there.
 *
 * - The title card: a white pill with the cover, title and artist in the
 *   top-left clear area, under the progress bar, from the Song's start to
 *   4 s; then it slides out to the left.
 * - The pause hint: "Space: pause" under the title card, for the same time,
 *   on the first Song since the Party started only (the Stage sets
 *   `SingState.pauseHint`).
 * - The time left: `m:ss` at the right end of the progress bar, counting
 *   down to the Song's end, for the whole Song.
 *
 * Like the rest of `frame()`, every entry is a pure function of Song time,
 * in the 1920 × 1080 reference frame, with colours as token names.
 */

import { t } from "../../i18n/t";
import type { PaletteKey, TokenName } from "../../theme/tokens";
import type { DrawList } from "./frame";

/** What the title card shows of the Song. */
export interface SingSong {
  title: string;
  artist: string;
  /** The cover image's URL; `null`: the Song's tile colour instead. */
  cover: string | null;
  /** The generated tile's colour, shown without a cover or until it loads. */
  tileColour: PaletteKey;
}

/** Which input the pause hint names (#275 tracks the last one used). */
export type PauseHint = "keyboard" | "gamepad";

/** A line of text: `x`, `y` is where the painter anchors it. */
export interface TextStyle {
  text: string;
  x: number;
  y: number;
  /** Font size in px; the font is the theme's (`--font-sans`). */
  size: number;
  weight: number;
  colour: TokenName;
}

/** The title card's cover: a rounded square with a white rim. */
export interface CoverStyle {
  x: number;
  y: number;
  size: number;
  radius: number;
  /** The image to draw once loaded; `null`: the tile only. */
  url: string | null;
  /** Filled under the image, so it shows without one or while it loads. */
  tile: PaletteKey;
  rim: TokenName;
  rimWidth: number;
}

/**
 * The title card: a full-radius pill at `x`, `y`, as wide as its text needs
 * up to `maxWidth`, over a ledge `ledgeDepth` px deep. Its title and artist
 * are left-aligned on their baselines.
 */
export interface TitleCardEntry {
  type: "titleCard";
  x: number;
  y: number;
  height: number;
  maxWidth: number;
  /** Space after the longer of the title and the artist. */
  paddingRight: number;
  fill: TokenName;
  alpha: number;
  ledge: TokenName;
  ledgeDepth: number;
  cover: CoverStyle;
  title: TextStyle;
  artist: TextStyle;
}

/** The pause hint: a full-radius pill at `x`, `y`, as wide as its text plus `padding` each side. */
export interface PauseHintEntry {
  type: "pauseHint";
  x: number;
  y: number;
  height: number;
  padding: number;
  fill: TokenName;
  /** Left-aligned on its baseline, `padding` in from the pill's left. */
  text: TextStyle;
}

/** The time left, right-aligned on `text.x` and centred on `text.y`, outlined for any video. */
export interface TimeLeftEntry {
  type: "timeLeft";
  text: TextStyle;
  outline: TokenName;
  outlineWidth: number;
}

/** The card shows this long from the Song's start, then slides out. */
export const TITLE_CARD_SECONDS = 4;
/** How long the slide-out takes. */
const SLIDE_SECONDS = 0.4;

const LEFT = 80;
const CARD = {
  y: 52,
  height: 104,
  maxWidth: 760,
  inset: 12,
  cover: 80,
  gap: 20,
  paddingRight: 36,
  ledgeDepth: 6,
};
const HINT = { gap: 14, height: 48, padding: 22, size: 24 };
/** Titles and artists longer than this are cut short with an ellipsis. */
const MAX_CHARACTERS = 40;

/** The progress bar's right end (#55) and the time left's room beside it. */
export const BAR_RIGHT = 1920 - 80;
const TIME_LEFT_SIZE = 28;
/** The room the time left takes at the right end of the progress bar. */
export const TIME_LEFT_ROOM = 100;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cut(text: string): string {
  if (text.length <= MAX_CHARACTERS) return text;
  const chars = Array.from(graphemes.segment(text), (s) => s.segment);
  return chars.length > MAX_CHARACTERS
    ? `${chars.slice(0, MAX_CHARACTERS - 1).join("")}…`
    : text;
}

/** How far the card has slid out, 0 to 1 (eased in); `null`: it is gone. */
function slide(songTime: number): number | null {
  if (songTime <= TITLE_CARD_SECONDS) return 0;
  const p = (songTime - TITLE_CARD_SECONDS) / SLIDE_SECONDS;
  return p >= 1 ? null : p * p * p;
}

/**
 * Pushes the top band's entries for Song time `songTime` in a Song of
 * `length` seconds: the time left whenever there is a length, the title card
 * and pause hint in the Song's first seconds.
 */
export function topBand(
  list: DrawList,
  state: { song?: SingSong | null; pauseHint?: PauseHint | null },
  songTime: number,
  length: number,
) {
  if (length > 0) {
    const left = Math.max(0, Math.ceil(length - Math.max(0, songTime)));
    list.push({
      type: "timeLeft",
      text: {
        text: t("songs.length", {
          minutes: Math.floor(left / 60),
          seconds: String(left % 60).padStart(2, "0"),
        }),
        x: BAR_RIGHT,
        y: 25,
        size: TIME_LEFT_SIZE,
        weight: 700,
        colour: "--color-white",
      },
      outline: "--color-ink",
      outlineWidth: 6,
    });
  }

  const song = state.song;
  const out = slide(songTime);
  if (!song || out === null) return;
  const x = LEFT - out * (CARD.maxWidth + LEFT);
  const textX = x + CARD.inset + CARD.cover + CARD.gap;
  list.push({
    type: "titleCard",
    x,
    y: CARD.y,
    height: CARD.height,
    maxWidth: CARD.maxWidth,
    paddingRight: CARD.paddingRight,
    fill: "--color-white",
    alpha: 0.94,
    ledge: "--color-lane-ledge",
    ledgeDepth: CARD.ledgeDepth,
    cover: {
      x: x + CARD.inset,
      y: CARD.y + CARD.inset,
      size: CARD.cover,
      radius: 18,
      url: song.cover,
      tile: song.tileColour,
      rim: "--color-white",
      rimWidth: 4,
    },
    title: {
      text: cut(song.title),
      x: textX,
      y: CARD.y + 50,
      size: 34,
      weight: 700,
      colour: "--color-ink",
    },
    artist: {
      text: cut(song.artist),
      x: textX,
      y: CARD.y + 84,
      size: 26,
      weight: 500,
      colour: "--color-ink-2",
    },
  });

  if (!state.pauseHint) return;
  const y = CARD.y + CARD.height + CARD.ledgeDepth + HINT.gap;
  list.push({
    type: "pauseHint",
    x,
    y,
    height: HINT.height,
    padding: HINT.padding,
    fill: "--color-ink",
    text: {
      text: t(
        state.pauseHint === "gamepad"
          ? "sing.pauseHint.gamepad"
          : "sing.pauseHint.keyboard",
      ),
      x: x + HINT.padding,
      y: y + 32,
      size: HINT.size,
      weight: 600,
      colour: "--color-white",
    },
  });
}
