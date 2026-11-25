// Compile-time checks of the colour display names. Never run; `tsc` checks
// each `@ts-expect-error`.

import { COLOUR_NAME_KEYS, colourName } from "./colourNames";
import type { PaletteKey } from "./paletteKeys";
import type { MessageKey } from "./t";

colourName("tangerine");
// @ts-expect-error: `orange` is not a palette key.
colourName("orange");

declare const elevenKeys: Omit<typeof COLOUR_NAME_KEYS, "tangerine">;
// @ts-expect-error: the mapping must name all twelve keys.
export const missingAColour: Record<PaletteKey, MessageKey> = elevenKeys;

export const unknownKey = {
  ...COLOUR_NAME_KEYS,
  // @ts-expect-error: every name must be a catalogue key.
  cherry: "colour.red",
} satisfies Record<PaletteKey, MessageKey>;
