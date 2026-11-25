// The twelve Party colour keys, in palette order (v1 spec #55).
//
// #107 adds the same list as `PALETTE_KEYS` / `PaletteKey` in
// `src/theme/tokens.ts`. Once both are merged, import from there and delete
// this file; `colourNames.ts` is the only user.

export const PALETTE_KEYS = [
  "cherry",
  "sky",
  "navy",
  "cocoa",
  "teal",
  "lime",
  "berry",
  "mint",
  "bubblegum",
  "forest",
  "grape",
  "tangerine",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
