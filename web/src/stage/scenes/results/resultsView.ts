// What the results screen draws for each Player (v1 spec #55, "Results screen
// and Rank titles"), from the ranked results the server sends (#175): pure,
// so the rules are tested without a browser.

import type { PlayerResult } from "../../../generated/PlayerResult";
import { SCORING } from "../../../scoring/constants";

/** The best total a Player can reach: every Note and every Line bonus. */
export const MAX_TOTAL = SCORING.notePoints + SCORING.lineBonusPoints;
/** A bar is never lower than this share of the full height, so 0 still shows. */
export const MIN_BAR_HEIGHT = 0.12;
/** How long one bar grows, with the spring easing. */
export const BAR_GROW_MS = 1100;
/** Each bar starts growing this long after the one before it. */
export const BAR_STAGGER_MS = 150;
/** The "New high score!" sticker pops this long after its bar has grown. */
export const STICKER_AFTER_MS = 900;

export interface BarView {
  player: PlayerResult;
  /** Share of the full bar height, `MIN_BAR_HEIGHT` to 1. */
  height: number;
  /** Each part's share of the bar, stacked from the bottom in this order. */
  parts: { notes: number; golden: number; lineBonus: number };
  /** Hatched with the "unfinished" stamp: the Player did not finish. */
  hatched: boolean;
  /** The "New high score!" sticker; never on an unfinished bar. */
  sticker: boolean;
  growDelayMs: number;
  stickerDelayMs: number;
}

export interface ResultsView {
  /** No Player finished: the banner replaces the artist line. */
  endedEarly: boolean;
  /** One bar per Player, in the server's ranking, left to right. */
  bars: BarView[];
  /** When the last bar has grown (the `fanfare`, #262), ms; `null` with no bars. */
  landMs: number | null;
  /** When the first "New high score!" sticker pops (`highScore`), ms. */
  highScoreMs: number | null;
}

export function resultsView(players: readonly PlayerResult[]): ResultsView {
  const bars = players.map((player, index): BarView => {
    const growDelayMs = index * BAR_STAGGER_MS;
    return {
      player,
      height: Math.min(1, Math.max(MIN_BAR_HEIGHT, player.total / MAX_TOTAL)),
      parts: parts(player),
      hatched: player.unfinished,
      sticker: player.newHighScore && !player.unfinished,
      growDelayMs,
      stickerDelayMs: growDelayMs + BAR_GROW_MS + STICKER_AFTER_MS,
    };
  });
  const last = bars.at(-1);
  const sticker = bars.find((bar) => bar.sticker);
  return {
    endedEarly: players.length > 0 && players.every((p) => p.unfinished),
    bars,
    landMs: last ? last.growDelayMs + BAR_GROW_MS : null,
    highScoreMs: sticker ? sticker.stickerDelayMs : null,
  };
}

function parts(player: PlayerResult): BarView["parts"] {
  const sum = player.notes + player.golden + player.lineBonus;
  // A bar with no points is all notes colour.
  if (sum <= 0) return { notes: 1, golden: 0, lineBonus: 0 };
  return {
    notes: player.notes / sum,
    golden: player.golden / sum,
    lineBonus: player.lineBonus / sum,
  };
}
