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

/**
 * A theme's sing screen beyond its colours (#267): how the lane panels and
 * the lyric bar are frosted and how heavy its ink lines are. `frame()` puts
 * these in the draw list, and the DOM panels and bar read the same values.
 */
export interface SingTheme {
  /**
   * `frosted`: the lane panels show the surface at the Lane frosting
   * option over a blurred backdrop; `solid`: fully opaque, whatever it says.
   */
  lanes: "frosted" | "solid";
  /** The frosted lane panels' backdrop blur, px. */
  laneBlur: number;
  /** The lyric bar's surface alpha and backdrop blur, px. */
  lyricBar: { readonly alpha: number; readonly blur: number };
  /** Every ink edge's width, as a share of Bubble Pop's: pill outlines, the pitch line's edge. */
  inkEdge: number;
  /** The faint ink lines' alphas: the pitch grid, the separator left of the Notes, the playhead. */
  gridAlpha: number;
  separatorAlpha: number;
  playheadAlpha: number;
}

/** Bubble Pop: v1's look (`THEME_DEFAULT` on the server). */
export const DEFAULT_THEME: Theme = "bubblePop";

/** One theme. */
export interface ThemeDef {
  tokens: ThemeTokens;
  sing: SingTheme;
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
 *
 * The four deep Party colours (navy, cocoa, berry, forest) would vanish on
 * deep navy, so Night lifts them to lighter tones of the same hues (#267):
 * every Party colour shows at 3 : 1 on Night's surfaces, as a lyric fill
 * (large text) and a pitch line, and the twelve stay as far apart as
 * Bubble Pop's for colour-blind viewers. The keys never change.
 */
const BUBBLE_POP_NIGHT: ThemeTokens = {
  ...BUBBLE_POP,
  "--color-party-navy": "#9282e4",
  "--color-party-cocoa": "#bd6c34",
  "--color-party-berry": "#b5628a",
  "--color-party-forest": "#4d9c76",
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

/**
 * High contrast (#267): black ink on plain white, every text at WCAG AA on
 * every surface it sits on (4.5 : 1; the lyric fill, large text, at 3 : 1),
 * passed Notes clearly darker, and the sing screen solid (`SOLID` below).
 * The page is plain white with no blobs, so coloured text reads on all of
 * it. Green carries both white text and `on-bright` (black), so it sits at
 * the one lightness where both read at 4.5 : 1. The light candy Party
 * colours are deepened to 3 : 1 on white, still as far apart as Bubble
 * Pop's for colour-blind viewers; the deep ones are Bubble Pop's.
 */
const HIGH_CONTRAST: ThemeTokens = {
  ...BUBBLE_POP,
  "--color-party-cherry": "#fc6156",
  "--color-party-sky": "#4e95ef",
  "--color-party-teal": "#2c8990",
  "--color-party-lime": "#82a01f",
  "--color-party-mint": "#02aa4b",
  "--color-party-bubblegum": "#f34baf",
  "--color-party-grape": "#9a5ff3",
  "--color-party-tangerine": "#dd7001",
  "--color-surface": "#ffffff",
  "--color-ink-fill": "#000000",
  "--color-on-bright": "#000000",
  "--color-cream": "#ffffff",
  "--color-cream-2": "#ffffff",
  "--color-ink": "#000000",
  "--color-ink-2": "#2b2d42",
  "--color-mute": "#3d4055",
  "--color-ledge": "rgba(0, 0, 0, 0.3)",
  "--color-red": "#c8102e",
  "--color-red-ledge": "#7a0a1c",
  "--color-blue": "#0a5cc2",
  "--color-green": "#258550",
  "--color-green-ledge": "#0a4d27",
  "--color-yellow-ledge": "#8a6400",
  "--color-ink-ledge": "#585d78",
  "--color-purple": "#6a2fd0",
  "--color-slate": "#585d78",
  "--color-passed": "#b4b7c9",
  "--color-warn-fg": "#8f0f1f",
  "--color-veil": "rgba(0, 0, 0, 0.6)",
  "--color-blob-blue": "#ffffff",
  "--color-blob-pink": "#ffffff",
  "--color-blob-green": "#ffffff",
  "--color-lane-ledge": "rgba(0, 0, 0, 0.4)",
  "--color-lane-shadow": "rgba(0, 0, 0, 0.25)",
  "--color-golden-text": "#8a5a00",
  "--color-lyric-ledge": "rgba(0, 0, 0, 0.4)",
  "--color-mic-lost-ledge": "rgba(0, 0, 0, 0.5)",
};

/** #55's sing screen: frosted lanes and lyric bar, thin faint ink lines. */
const FROSTED: SingTheme = {
  lanes: "frosted",
  laneBlur: 16,
  lyricBar: { alpha: 0.86, blur: 14 },
  inkEdge: 1,
  gridAlpha: 0.07,
  separatorAlpha: 0.12,
  playheadAlpha: 0.3,
};

/**
 * High contrast's sing screen: solid lanes and lyric bar with nothing
 * showing through, a 1.5 × ink edge, and the faint lines darker.
 */
const SOLID: SingTheme = {
  lanes: "solid",
  laneBlur: 0,
  lyricBar: { alpha: 1, blur: 0 },
  inkEdge: 1.5,
  gridAlpha: 0.18,
  separatorAlpha: 0.35,
  playheadAlpha: 0.6,
};

/** Every theme's values. */
export const THEMES: Readonly<Record<Theme, ThemeDef>> = {
  bubblePop: { tokens: BUBBLE_POP, sing: FROSTED },
  bubblePopNight: { tokens: BUBBLE_POP_NIGHT, sing: FROSTED },
  highContrast: { tokens: HIGH_CONTRAST, sing: SOLID },
};

export function isTheme(value: unknown): value is Theme {
  return (THEME_NAMES as readonly unknown[]).includes(value);
}

/** The theme on the document root; Bubble Pop until one is applied there. */
let shown: Theme = DEFAULT_THEME;
const shownListeners = new Set<() => void>();

/**
 * The theme shown on this document: what `applyTheme` last put on the
 * document root. The render loop reads it every frame; `useShownTheme`
 * re-renders the DOM on a change.
 */
export function shownTheme(): Theme {
  return shown;
}

/** Calls `listener` after each change of `shownTheme()`; returns the unsubscribe. */
export function subscribeShownTheme(listener: () => void): () => void {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
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
  if (root === document.documentElement && theme !== shown) {
    shown = theme;
    for (const listener of shownListeners) listener();
  }
}
