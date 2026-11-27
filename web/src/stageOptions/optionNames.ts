// Each Stage option's shown name: the heading of its row in the Options
// list (`OptionsList.tsx`), and the name a toast or Party change gives it
// ("Sam changed Effects"). Keyed by the generated `StageOptionKey`, so an
// option added on the Rust side fails `tsc` here until it has a name.

import type { StageOptionKey } from "../generated/StageOptionKey";
import type { en } from "../i18n/en";
import { t, type ArgsOf, type MessageKey } from "../i18n/t";

/** A catalogue key that takes no parameters (a row's name or help). */
export type PlainKey = {
  [K in MessageKey]: ArgsOf<(typeof en)[K]> extends [] ? K : never;
}[MessageKey];

export const OPTION_NAMES = {
  startingDifficulty: "options.startingDifficulty",
  resumeCountdownSeconds: "options.resumeCountdown",
  lineRatings: "options.lineRatings",
  effects: "options.effects",
  songVideo: "options.songVideo",
  previewVolumePercent: "options.previewVolume",
  skipIntros: "options.skipIntros",
  lyricSize: "options.lyricSize",
  showNextLine: "options.showNextLine",
  laneFrostingPercent: "options.laneFrosting",
  theme: "options.theme",
  uiSoundsPercent: "options.uiSounds",
} as const satisfies Record<StageOptionKey, PlainKey>;

/**
 * The shown name of the one option a change names (`stageOptionsChanged`),
 * or `null` for several: the toast then says "the Options".
 */
export function changedOptionName(
  options: readonly StageOptionKey[],
): string | null {
  const [only] = options;
  return options.length === 1 && only !== undefined
    ? t(OPTION_NAMES[only])
    : null;
}
