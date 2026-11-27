// The themes' names and the default, with nothing of the DOM, so the Stage
// options' defaults (`stageOptions.ts`) can name it; `themes.ts` holds each
// theme's values and re-exports these.

import type { Theme } from "../generated/Theme";

/** Bubble Pop: v1's look (`THEME_DEFAULT` on the server). */
export const DEFAULT_THEME: Theme = "bubblePop";

/** The three themes, in the order Options shows them. */
export const THEME_NAMES = [
  "bubblePop",
  "bubblePopNight",
  "highContrast",
] as const satisfies readonly Theme[];

export function isTheme(value: unknown): value is Theme {
  return (THEME_NAMES as readonly unknown[]).includes(value);
}
