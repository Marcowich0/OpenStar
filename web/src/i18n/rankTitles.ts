// The eight Rank titles (v1 spec #55, "Results screen and Rank titles"): one
// per 1250 points. The server sends the band (`PlayerResult.rankTitleBand`,
// `min(7, floor(total / 1250))`); the Stage's results and the Phone's own
// result both name it with `rankTitle`.

import { t, type MessageKey } from "./t";

export const RANK_TITLE_KEYS = [
  "rankTitle.showerSinger",
  "rankTitle.hummingbird",
  "rankTitle.warmingUp",
  "rankTitle.gettingLoud",
  "rankTitle.crowdPleaser",
  "rankTitle.headliner",
  "rankTitle.rockStar",
  "rankTitle.openStar",
] as const satisfies readonly MessageKey[];

/** The Rank title of a band (0 to 7); a band out of range keeps the nearest. */
export function rankTitle(band: number): string {
  const index = Math.min(
    RANK_TITLE_KEYS.length - 1,
    Math.max(0, Math.floor(band)),
  );
  return t(RANK_TITLE_KEYS[index] ?? "rankTitle.showerSinger");
}
