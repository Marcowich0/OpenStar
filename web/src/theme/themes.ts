// The themes, Stage option `theme` (spec #243): each maps every token and the
// twelve palette keys to its own values, as #55 designed. State and messages
// hold palette keys and token names, never these values, so a theme changes
// how a key looks and nothing else. `applyTheme` writes a theme on the
// document root, where every screen and the canvas (`readToken`) read the
// tokens; `tokens.css` holds Bubble Pop, the default, before any theme is
// applied. See `tokens.css` for what each colour token is for in every theme.
//
// To add a token: its line in `tokens.css`, its name in `tokens.ts`, and its
// value in each map below (`tsc` fails on a map without it). A theme's
// non-CSS values (the sing screen's, #267) go in `ThemeDef` beside `tokens`.

import type { Theme } from "../generated/Theme";
import type { TokenName } from "./tokens";

/** A value for every token and palette key's token. */
export type ThemeTokens = Readonly<Record<TokenName, string>>;

/** One theme. */
export interface ThemeDef {
  tokens: ThemeTokens;
}

/** The three themes, in the order Options shows them. */
export const THEME_NAMES = [
  "bubblePop",
  "bubblePopNight",
  "highContrast",
] as const satisfies readonly Theme[];

/** Bubble Pop: cream and candy colours, exactly `tokens.css`. */
const BUBBLE_POP: ThemeTokens = {
  "--color-party-cherry": "#ff4b5c",
  "--color-party-sky": "#2ea8ff",
  "--color-party-navy": "#1f3f9e",
  "--color-party-cocoa": "#7a3e12",
  "--color-party-teal": "#12bfc4",
  "--color-party-lime": "#9bd62b",
  "--color-party-berry": "#8b1457",
  "--color-party-mint": "#3ddc84",
  "--color-party-bubblegum": "#ff6fb5",
  "--color-party-forest": "#146b3a",
  "--color-party-grape": "#9b5cff",
  "--color-party-tangerine": "#ff7a1a",
  "--color-surface": "#ffffff",
  "--color-ink-fill": "#2b2d42",
  "--color-on-bright": "#2b2d42",
  "--color-white": "#ffffff",
  "--color-cream": "#fff6e9",
  "--color-cream-2": "#ffe7cc",
  "--color-ink": "#2b2d42",
  "--color-ink-2": "#5d6079",
  "--color-mute": "#8a8ca0",
  "--color-ledge": "rgba(43, 45, 66, 0.14)",
  "--color-red": "#ff4b5c",
  "--color-red-ledge": "#c7303f",
  "--color-blue": "#2ea8ff",
  "--color-green": "#3ddc84",
  "--color-green-ledge": "#24a862",
  "--color-yellow": "#ffc93c",
  "--color-yellow-ledge": "#d9a21a",
  "--color-ink-ledge": "#14151f",
  "--color-purple": "#9b5cff",
  "--color-slate": "#7c82a0",
  "--color-golden-top": "#ffe58a",
  "--color-golden-bottom": "#ffb020",
  "--color-passed": "#ecedf5",
  "--color-warn-bg": "#ffe1e4",
  "--color-warn-fg": "#b3192b",
  "--color-veil": "rgba(43, 45, 66, 0.4)",
  "--color-blob-blue": "#cdebff",
  "--color-blob-pink": "#ffd6dc",
  "--color-blob-green": "#d9f7e6",
  "--color-lane-ledge": "rgba(43, 45, 66, 0.18)",
  "--color-lane-shadow": "rgba(0, 0, 0, 0.18)",
  "--color-golden-text": "#e09a00",
  "--color-lyric-ledge": "rgba(43, 45, 66, 0.2)",
  "--color-mic-lost-ledge": "rgba(0, 0, 0, 0.25)",
  "--color-fit-low": "hsl(0 75% 55%)",
  "--color-fit-high": "hsl(120 75% 55%)",
  "--radius-card-sm": "36px",
  "--radius-card": "44px",
  "--radius-card-lg": "52px",
  "--shadow-ledge-sm": "0 6px 0 var(--color-ledge)",
  "--shadow-ledge": "0 8px 0 var(--color-ledge)",
  "--shadow-ledge-lg": "0 10px 0 var(--color-ledge)",
  "--shadow-ledge-green": "0 8px 0 var(--color-green-ledge)",
  "--shadow-ledge-red": "0 8px 0 var(--color-red-ledge)",
  "--shadow-ledge-ink": "0 8px 0 var(--color-ink-ledge)",
  "--shadow-ledge-yellow": "0 8px 0 var(--color-yellow-ledge)",
  "--shadow-ledge-lyric": "0 10px 0 var(--color-lyric-ledge)",
  "--shadow-ledge-mic-lost": "0 6px 0 var(--color-mic-lost-ledge)",
  "--ease-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "--ease-exit": "cubic-bezier(0.36, 0, 0.66, -0.56)",
  "--default-transition-timing-function": "var(--ease-spring)",
  // Motion (#260). Every theme keeps these Bubble Pop values, so
  // `applyTheme` leaves them to the stylesheet and its
  // `:root[data-motion="fade"]` block still turns them into fades.
  "--motion-spring": "450ms",
  "--motion-bounce": "350ms",
  "--motion-press": "200ms",
  "--motion-exit": "250ms",
  "--motion-fade": "120ms",
  "--motion-press-scale": "0.94",
  "--motion-focus-scale": "1.06",
  "--motion-overlay-scale": "0.9",
  "--motion-toast-drop": "-40px",
  "--motion-sheet-rise": "100%",
  "--animate-breathe": "breathe 1.45s ease-in-out infinite",
  "--animate-pop-in": "pop-in 0.45s var(--ease-spring) both",
  "--animate-shake": "shake 0.3s linear",
  "--animate-float": "float 9s ease-in-out infinite",
  "--animate-toast-out": "toast-out 0.35s ease-in both",
  "--animate-line-in": "line-in 0.35s var(--ease-spring) both",
  "--animate-squish": "squish 0.65s var(--ease-spring)",
  "--animate-bob": "bob 3s ease-in-out infinite",
  "--animate-mic-lost-dot": "mic-lost-dot 1.2s infinite",
  "--animate-focus-bounce":
    "focus-bounce var(--motion-bounce) var(--ease-spring)",
  "--animate-overlay-in":
    "overlay-in var(--motion-spring) var(--ease-spring) both",
  "--animate-overlay-out":
    "overlay-out var(--motion-exit) var(--ease-exit) both",
  "--animate-toast-in": "toast-in var(--motion-spring) var(--ease-spring) both",
  "--animate-veil-out": "fade-out var(--motion-exit) ease-in both",
  "--animate-fade-in": "fade-in var(--motion-fade) ease-out both",
  "--animate-fade-out": "fade-out var(--motion-fade) ease-in both",
  "--font-sans": '"Fredoka", ui-rounded, system-ui, sans-serif',
};

/**
 * Bubble Pop Night: the cream background turned deep navy, the same candy
 * palette. Text is light; `surface` cards sit a step lighter than the page;
 * `ink-fill` is the darkest fill, under white text. The candy fills keep
 * their Bubble Pop pairs.
 */
const BUBBLE_POP_NIGHT: ThemeTokens = {
  ...BUBBLE_POP,
  "--color-surface": "#2a3060",
  "--color-ink-fill": "#0d1027",
  "--color-cream": "#1b1f3f",
  "--color-cream-2": "#11142b",
  "--color-ink": "#fff6e9",
  "--color-ink-2": "#c9cbe3",
  "--color-mute": "#a3a7c9",
  "--color-ledge": "rgba(0, 0, 0, 0.32)",
  "--color-ink-ledge": "#04050f",
  "--color-passed": "#3a4070",
  "--color-warn-bg": "#4a1a2a",
  "--color-warn-fg": "#ff9faa",
  "--color-veil": "rgba(4, 6, 20, 0.6)",
  "--color-blob-blue": "#1d3a7a",
  "--color-blob-pink": "#5b2453",
  "--color-blob-green": "#164c44",
  "--color-lane-ledge": "rgba(0, 0, 0, 0.35)",
  "--color-lane-shadow": "rgba(0, 0, 0, 0.4)",
  "--color-golden-text": "#ffc93c",
  "--color-lyric-ledge": "rgba(0, 0, 0, 0.4)",
  "--color-mic-lost-ledge": "rgba(0, 0, 0, 0.4)",
};

/** Every theme's values. */
export const THEMES: Readonly<Record<Theme, ThemeDef>> = {
  bubblePop: { tokens: BUBBLE_POP },
  bubblePopNight: { tokens: BUBBLE_POP_NIGHT },
  // A placeholder until its own values are built (#267): solid lanes,
  // thicker ink edges, AA text on every surface.
  highContrast: { tokens: BUBBLE_POP },
};

export function isTheme(value: unknown): value is Theme {
  return (THEME_NAMES as readonly unknown[]).includes(value);
}

/**
 * Shows `theme` on every screen at once: its values on `root` (the document
 * element, above the portalled dialogs too) and its name in `data-theme`. A
 * token with its Bubble Pop value is left to the stylesheet, so the
 * stylesheet's own overrides of it (Motion's `data-motion`) still apply.
 */
export function applyTheme(
  theme: Theme,
  root: HTMLElement = document.documentElement,
): void {
  const tokens = THEMES[theme].tokens;
  for (const [name, value] of Object.entries(tokens) as [TokenName, string][]) {
    if (value === BUBBLE_POP[name]) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  root.dataset.theme = theme;
}
