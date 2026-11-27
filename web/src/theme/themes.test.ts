// The themes (Stage option `theme`, spec #243): each maps every token and the
// twelve palette keys to its own values, Bubble Pop is exactly `tokens.css`,
// Bubble Pop Night keeps the candy palette and reads at WCAG AA, and applying
// a theme sets its values at the document root.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Theme } from "../generated/Theme";
import { contrastRatio } from "./contrast";
import { applyTheme, THEME_NAMES, THEMES } from "./themes";
import tokensCss from "./tokens.css?raw";
import {
  PALETTE_KEYS,
  PARTY_COLOUR_TOKENS,
  readToken,
  themeDeclarations,
  TOKEN_NAMES,
  type TokenName,
} from "./tokens";

describe("every theme", () => {
  it.each(THEME_NAMES)(
    "%s gives every token and palette key a value",
    (theme) => {
      const tokens = THEMES[theme].tokens;
      expect(Object.keys(tokens).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) {
        expect(tokens[name], `${theme} ${name}`).toMatch(/\S/);
      }
      for (const key of PALETTE_KEYS) {
        expect(tokens[PARTY_COLOUR_TOKENS[key]], `${theme} ${key}`).toMatch(
          /\S/,
        );
      }
    },
  );

  it("is one of the three the Stage option offers", () => {
    expect(THEME_NAMES).toEqual([
      "bubblePop",
      "bubblePopNight",
      "highContrast",
    ]);
  });
});

describe("Bubble Pop", () => {
  it("is exactly the default stylesheet, tokens.css", () => {
    expect(Object.fromEntries(themeDeclarations(tokensCss))).toEqual(
      THEMES.bubblePop.tokens,
    );
  });
});

describe("Bubble Pop Night", () => {
  const night = THEMES.bubblePopNight.tokens;

  it("keeps the same candy palette: every Party colour as in Bubble Pop", () => {
    for (const key of PALETTE_KEYS) {
      const token = PARTY_COLOUR_TOKENS[key];
      expect(night[token], key).toBe(THEMES.bubblePop.tokens[token]);
    }
  });

  it("turns the cream background and the white surfaces to deep navy", () => {
    for (const background of [
      "--color-cream",
      "--color-cream-2",
      "--color-surface",
    ] as const) {
      expect(
        contrastRatio(night[background], night["--color-ink"]),
        background,
      ).toBeGreaterThan(7);
      // Dark: far nearer black than white.
      expect(contrastRatio(night[background], "#000000")).toBeLessThan(2);
    }
  });

  // Text (first) on the background it sits on (second), on Night's own
  // surfaces. The candy fills keep Bubble Pop's pairs: the palette is the same.
  const PAIRS: readonly (readonly [TokenName, TokenName])[] = [
    ["--color-ink", "--color-cream"],
    ["--color-ink", "--color-cream-2"],
    ["--color-ink", "--color-surface"],
    ["--color-ink", "--color-passed"],
    ["--color-ink-2", "--color-cream"],
    ["--color-ink-2", "--color-cream-2"],
    ["--color-ink-2", "--color-surface"],
    ["--color-ink-2", "--color-passed"],
    ["--color-mute", "--color-cream"],
    ["--color-mute", "--color-cream-2"],
    ["--color-mute", "--color-surface"],
    ["--color-warn-fg", "--color-warn-bg"],
    ["--color-warn-fg", "--color-surface"],
    ["--color-warn-fg", "--color-cream"],
    ["--color-golden-text", "--color-surface"],
    ["--color-white", "--color-ink-fill"],
    ["--color-on-bright", "--color-yellow"],
    ["--color-on-bright", "--color-green"],
    ["--color-on-bright", "--color-golden-top"],
    ["--color-on-bright", "--color-golden-bottom"],
    ["--color-on-bright", "--color-white"],
  ];

  it.each(PAIRS)("puts %s on %s at WCAG AA (4.5 : 1)", (text, background) => {
    expect(
      contrastRatio(night[text], night[background]),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("applyTheme", () => {
  // jsdom does not know Tailwind's `@theme`; Tailwind emits the same block as
  // `:root` custom properties, so load it that way.
  let style: HTMLStyleElement;
  const root = document.documentElement;

  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = tokensCss.replace(/@theme static/, ":root");
    document.head.append(style);
  });

  afterEach(() => {
    style.remove();
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
  });

  const lower = (value: string) => value.toLowerCase();

  it("sets the theme's values at the document root, where every screen reads them", () => {
    applyTheme("bubblePopNight");
    expect(root.dataset.theme).toBe("bubblePopNight");
    expect(lower(readToken("--color-cream"))).toBe(
      lower(THEMES.bubblePopNight.tokens["--color-cream"]),
    );
    expect(lower(readToken("--color-ink"))).toBe(
      lower(THEMES.bubblePopNight.tokens["--color-ink"]),
    );
  });

  it("goes back to the stylesheet's Bubble Pop", () => {
    applyTheme("bubblePopNight");
    applyTheme("bubblePop");
    expect(root.dataset.theme).toBe("bubblePop");
    expect(root.getAttribute("style") ?? "").toBe("");
    expect(lower(readToken("--color-cream"))).toBe("#fff6e9");
  });

  it("leaves alone the tokens a theme does not change, such as motion", () => {
    // Motion (`data-motion`) overrides the animations in the stylesheet; an
    // inline value would beat it.
    for (const theme of THEME_NAMES) {
      applyTheme(theme);
      expect(root.style.getPropertyValue("--animate-pop-in"), theme).toBe("");
    }
  });

  it("treats High contrast as Bubble Pop until its own values are built", () => {
    const theme: Theme = "highContrast";
    applyTheme(theme);
    expect(root.dataset.theme).toBe("highContrast");
    expect(lower(readToken("--color-cream"))).toBe("#fff6e9");
  });
});
