import type { PaletteKey } from "../theme/tokens";
import { t, type MessageKey } from "./t";

/**
 * Every Party colour's display name, by palette key. `satisfies` makes the
 * mapping exhaustive over the twelve keys and checks that each names a
 * catalogue key (see `colourNames.typetest.ts`).
 */
export const COLOUR_NAME_KEYS = {
  cherry: "colour.cherry",
  sky: "colour.sky",
  navy: "colour.navy",
  cocoa: "colour.cocoa",
  teal: "colour.teal",
  lime: "colour.lime",
  berry: "colour.berry",
  mint: "colour.mint",
  bubblegum: "colour.bubblegum",
  forest: "colour.forest",
  grape: "colour.grape",
  tangerine: "colour.tangerine",
} as const satisfies Record<PaletteKey, MessageKey>;

/**
 * A Party colour's fixed display name ("Tangerine"): on the colour picker,
 * in People, in toasts and as a swatch's accessible label.
 */
export function colourName(key: PaletteKey): string {
  return t(COLOUR_NAME_KEYS[key]);
}
