// Compile-time checks of the palette keys. This file is never run: `tsc`
// checks it, and each `@ts-expect-error` fails the build if its line stops
// being an error. Together they show that the key-to-token mapping in
// `tokens.ts` is exhaustive: it is declared with
// `satisfies PartyColourTokenMap`, which is what fails below.

import {
  PARTY_COLOUR_TOKENS,
  readToken,
  tokenVar,
  type PaletteKey,
  type PartyColourTokenMap,
} from "./tokens";

declare const withoutTangerine: Omit<typeof PARTY_COLOUR_TOKENS, "tangerine">;

// @ts-expect-error: removing a key's token (here tangerine's) fails.
export const missingToken = withoutTangerine satisfies PartyColourTokenMap;

export const extraToken = {
  ...PARTY_COLOUR_TOKENS,
  // @ts-expect-error: a token for a key that is not in the palette fails.
  gold: "--color-party-gold",
} satisfies PartyColourTokenMap;

export const swappedToken = {
  ...PARTY_COLOUR_TOKENS,
  // @ts-expect-error: a key mapped to another key's token fails.
  cherry: "--color-party-sky",
} satisfies PartyColourTokenMap;

// Adding a key to the palette without a token: the same mapping checked
// against a palette of thirteen keys fails.
type ThirteenKeys = PaletteKey | "gold";
// @ts-expect-error: `gold` has no token.
export const thirteen = PARTY_COLOUR_TOKENS satisfies Record<
  ThirteenKeys,
  string
>;

// @ts-expect-error: the palette has exactly the twelve keys; `red` is an interface colour.
export const notAKey: PaletteKey = "red";

// @ts-expect-error: a colour name is not a palette key or token.
export const unknownRef = readToken("white");

// @ts-expect-error: an unknown token name fails.
export const unknownToken = tokenVar("--color-gold");
