// The design tokens as TypeScript sees them: the palette keys, the token names,
// and the one reader that resolves either to its current value. The values
// themselves live only in `tokens.css` (Tailwind `@theme`), which puts every
// token on the document as a CSS custom property. The DOM uses them through
// `tokenVar` (a `var(--…)` reference); the canvas through `readToken`, which
// reads the property at call time, so changing a property changes what the
// canvas draws with no rebuild.

/**
 * The twelve Party colour keys, in palette order. State, messages and
 * components hold these keys, never a colour value.
 *
 * #80 adds the same keys to `crates/protocol`; once the generated type exists,
 * `PaletteKey` should become that type (this list stays as the ordered value).
 */
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

export function isPaletteKey(value: unknown): value is PaletteKey {
  return (PALETTE_KEYS as readonly unknown[]).includes(value);
}

/** A token for every palette key, named after the key. */
export type PartyColourTokenMap = { [K in PaletteKey]: `--color-party-${K}` };

/**
 * Every Party colour key's token. `satisfies` makes the mapping exhaustive: a
 * key without a token, or a token for a key that is not in the palette, fails
 * `tsc` (see `tokens.typetest.ts`).
 */
export const PARTY_COLOUR_TOKENS = {
  cherry: "--color-party-cherry",
  sky: "--color-party-sky",
  navy: "--color-party-navy",
  cocoa: "--color-party-cocoa",
  teal: "--color-party-teal",
  lime: "--color-party-lime",
  berry: "--color-party-berry",
  mint: "--color-party-mint",
  bubblegum: "--color-party-bubblegum",
  forest: "--color-party-forest",
  grape: "--color-party-grape",
  tangerine: "--color-party-tangerine",
} as const satisfies PartyColourTokenMap;

/** The interface tokens (everything in the theme that is not a Party colour). */
export const INTERFACE_TOKENS = [
  "--color-white",
  "--color-cream",
  "--color-cream-2",
  "--color-ink",
  "--color-ink-2",
  "--color-mute",
  "--color-ledge",
  "--color-red",
  "--color-red-ledge",
  "--color-blue",
  "--color-green",
  "--color-green-ledge",
  "--color-yellow",
  "--color-yellow-ledge",
  "--color-ink-ledge",
  "--color-purple",
  "--color-slate",
  "--color-golden-top",
  "--color-golden-bottom",
  "--color-passed",
  "--color-warn-bg",
  "--color-warn-fg",
  "--color-veil",
  "--color-blob-blue",
  "--color-blob-pink",
  "--color-blob-green",
  "--color-lane-ledge",
  "--color-lane-shadow",
  "--color-golden-text",
  "--color-lyric-ledge",
  "--color-mic-lost-ledge",
  "--color-fit-low",
  "--color-fit-high",
  "--radius-card-sm",
  "--radius-card",
  "--radius-card-lg",
  "--shadow-ledge-sm",
  "--shadow-ledge",
  "--shadow-ledge-lg",
  "--shadow-ledge-green",
  "--shadow-ledge-red",
  "--shadow-ledge-ink",
  "--shadow-ledge-yellow",
  "--shadow-ledge-lyric",
  "--shadow-ledge-mic-lost",
  "--ease-spring",
  "--ease-exit",
  "--default-transition-timing-function",
  "--motion-spring",
  "--motion-bounce",
  "--motion-press",
  "--motion-exit",
  "--motion-fade",
  "--motion-press-scale",
  "--motion-focus-scale",
  "--motion-overlay-scale",
  "--motion-toast-drop",
  "--motion-sheet-rise",
  "--animate-breathe",
  "--animate-pop-in",
  "--animate-shake",
  "--animate-float",
  "--animate-toast-out",
  "--animate-line-in",
  "--animate-squish",
  "--animate-bob",
  "--animate-mic-lost-dot",
  "--animate-focus-bounce",
  "--animate-overlay-in",
  "--animate-overlay-out",
  "--animate-toast-in",
  "--animate-veil-out",
  "--animate-fade-in",
  "--animate-fade-out",
  "--font-sans",
] as const;

export type InterfaceToken = (typeof INTERFACE_TOKENS)[number];
export type PartyColourToken = (typeof PARTY_COLOUR_TOKENS)[PaletteKey];
export type TokenName = InterfaceToken | PartyColourToken;

/** Every token name the theme defines. */
export const TOKEN_NAMES: readonly TokenName[] = [
  ...PALETTE_KEYS.map((key) => PARTY_COLOUR_TOKENS[key]),
  ...INTERFACE_TOKENS,
];

/** A palette key or a token name: what a component or draw-list entry names. */
export type TokenRef = PaletteKey | TokenName;

function tokenOf(ref: TokenRef): TokenName {
  return isPaletteKey(ref) ? PARTY_COLOUR_TOKENS[ref] : ref;
}

/** A `var(--…)` reference for the DOM (inline styles, SVG fills). */
export function tokenVar(ref: TokenRef): string {
  return `var(${tokenOf(ref)})`;
}

/**
 * The current value of a palette key or token, read from the CSS custom
 * properties on `root` (the document element by default). For the canvas,
 * which cannot use `var()`. Reads at call time: a painter reads once per frame.
 */
export function readToken(
  ref: TokenRef,
  root: Element = document.documentElement,
): string {
  return getComputedStyle(root).getPropertyValue(tokenOf(ref)).trim();
}

/**
 * The custom properties a theme stylesheet declares in its `@theme` block, in
 * source order. Tailwind's namespace resets (`--color-*: initial`) are not
 * declarations of a token and do not match.
 * Used by the tests that pin the theme.
 */
export function themeDeclarations(css: string): Map<string, string> {
  const block = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    declarations.set(name, value.trim());
  }
  return declarations;
}
