// The themes (Stage option `theme`, spec #243): each maps every token and the
// twelve palette keys to its own values, Bubble Pop is exactly `tokens.css`,
// Bubble Pop Night keeps the candy palette and reads at WCAG AA, and applying
// a theme sets its values at the document root.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Theme } from "../generated/Theme";
import { colourDistance, contrastRatio, over, VISIONS } from "./contrast";
import {
  applyTheme,
  shownTheme,
  subscribeShownTheme,
  THEME_NAMES,
  THEMES,
} from "./themes";
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

  // #55: a theme keeps the twelve Party colours distinguishable for
  // colour-blind viewers. The floors sit just under Bubble Pop's own closest
  // pairs (berry and bubblegum; lime and tangerine for deuteranopes), so no
  // theme reads worse than #55's palette.
  const FLOORS: Readonly<Record<(typeof VISIONS)[number], number>> = {
    normal: 25,
    protan: 9,
    deutan: 9,
    tritan: 9,
  };

  it.each(THEME_NAMES)(
    "%s keeps every two Party colours apart, in normal vision and the three colour blindnesses",
    (theme) => {
      const tokens = THEMES[theme].tokens;
      const colours = PALETTE_KEYS.map((key) => [
        key,
        tokens[PARTY_COLOUR_TOKENS[key]],
      ]);
      for (const vision of VISIONS) {
        for (const [i, [a, x]] of colours.entries()) {
          for (const [b, y] of colours.slice(i + 1)) {
            expect(
              colourDistance(x ?? "", y ?? "", vision),
              `${theme} ${String(a)} / ${String(b)}, ${vision}`,
            ).toBeGreaterThanOrEqual(FLOORS[vision]);
          }
        }
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

  // The deep Party colours read poorly on deep navy (#266), so Night lifts
  // those four, keeping their keys and hues; the candy colours stay as they are.
  const LIFTED = ["navy", "cocoa", "berry", "forest"] as const;

  it("keeps the candy palette: every Party colour as in Bubble Pop but the four deep ones", () => {
    for (const key of PALETTE_KEYS) {
      const token = PARTY_COLOUR_TOKENS[key];
      if ((LIFTED as readonly string[]).includes(key)) continue;
      expect(night[token], key).toBe(THEMES.bubblePop.tokens[token]);
    }
  });

  it.each(LIFTED)(
    "lifts %s: lighter than Bubble Pop's, on the same keys",
    (key) => {
      const token = PARTY_COLOUR_TOKENS[key];
      const bubblePop = THEMES.bubblePop.tokens[token];
      expect(contrastRatio(night[token], "#000000"), key).toBeGreaterThan(
        contrastRatio(bubblePop, "#000000") * 1.5,
      );
    },
  );

  it.each(PALETTE_KEYS)(
    "shows %s at 3 : 1 on Night's surfaces, as a lyric fill (large text) and a pitch line",
    (key) => {
      const colour = night[PARTY_COLOUR_TOKENS[key]];
      for (const background of ["--color-surface", "--color-cream"] as const) {
        expect(
          contrastRatio(colour, night[background]),
          background,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

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

describe("High contrast", () => {
  const hc = THEMES.highContrast.tokens;

  // Text (first) on the background it sits on (second), as the screens use
  // them: plain text on the page, cards and Chips; white on the dark and
  // coloured fills; `on-bright` on the bright fills; coloured text on cards
  // and on the Phone's ink cards. WCAG AA for body text, 4.5 : 1, on every one.
  const PAIRS: readonly (readonly [TokenName, TokenName])[] = [
    ...(["--color-ink", "--color-ink-2", "--color-mute"] as const).flatMap(
      (text) =>
        (
          [
            "--color-cream",
            "--color-cream-2",
            "--color-surface",
            "--color-passed",
            "--color-warn-bg",
          ] as const
        ).map((background) => [text, background] as const),
    ),
    ...(
      [
        "--color-warn-fg",
        "--color-red",
        "--color-green",
        "--color-green-ledge",
        "--color-purple",
        "--color-golden-text",
      ] as const
    ).flatMap((text) =>
      (["--color-surface", "--color-cream", "--color-cream-2"] as const).map(
        (background) => [text, background] as const,
      ),
    ),
    ["--color-warn-fg", "--color-warn-bg"],
    ...(
      [
        "--color-ink-fill",
        "--color-red",
        "--color-green",
        "--color-blue",
        "--color-purple",
        "--color-slate",
      ] as const
    ).map((background) => ["--color-white", background] as const),
    ["--color-yellow", "--color-ink-fill"],
    ["--color-green", "--color-ink-fill"],
    ...(
      [
        "--color-yellow",
        "--color-green",
        "--color-golden-top",
        "--color-golden-bottom",
        "--color-white",
      ] as const
    ).map((background) => ["--color-on-bright", background] as const),
  ];

  it.each(PAIRS)("puts %s on %s at WCAG AA (4.5 : 1)", (text, background) => {
    expect(contrastRatio(hc[text], hc[background])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([0.6, 0.7, 0.8])(
    "puts white at %s on the ink fill at AA, the Phone's quiet text on ink cards",
    (alpha) => {
      const text = over(hc["--color-white"], alpha, hc["--color-ink-fill"]);
      expect(
        contrastRatio(text, hc["--color-ink-fill"]),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(PALETTE_KEYS)(
    "puts the lane header's ink at AA on the solid %s lane (the surface tinted 16 %)",
    (key) => {
      const lane = over(
        hc[PARTY_COLOUR_TOKENS[key]],
        0.16,
        hc["--color-surface"],
      );
      expect(contrastRatio(hc["--color-ink"], lane)).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it.each([...PALETTE_KEYS, "slate"] as const)(
    "fills the lyrics in %s at AA for large text (3 : 1) on the solid lyric bar",
    (key) => {
      const token: TokenName =
        key === "slate" ? "--color-slate" : PARTY_COLOUR_TOKENS[key];
      expect(
        contrastRatio(hc[token], hc["--color-surface"]),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it("draws passed Notes clearly darker than the white Notes still to sing, and darker than Bubble Pop's", () => {
    const passed = hc["--color-passed"];
    expect(contrastRatio(passed, hc["--color-white"])).toBeGreaterThanOrEqual(
      1.6,
    );
    expect(contrastRatio(passed, "#000000")).toBeLessThan(
      contrastRatio(THEMES.bubblePop.tokens["--color-passed"], "#000000"),
    );
  });

  it("draws the sing screen solid: lanes and lyric bar opaque with no blur, a 1.5 × ink edge", () => {
    expect(THEMES.highContrast.sing).toMatchObject({
      lanes: "solid",
      laneBlur: 0,
      lyricBar: { alpha: 1, blur: 0 },
      inkEdge: 1.5,
    });
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
    applyTheme("bubblePop");
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

  it("shows High contrast's own values", () => {
    const theme: Theme = "highContrast";
    applyTheme(theme);
    expect(root.dataset.theme).toBe("highContrast");
    expect(lower(readToken("--color-ink"))).toBe(
      lower(THEMES.highContrast.tokens["--color-ink"]),
    );
    expect(readToken("--color-ink")).not.toBe("#2b2d42");
  });

  it("tells the shown theme's followers, once per change, only for the document root", () => {
    const seen: string[] = [];
    const stop = subscribeShownTheme(() => seen.push(shownTheme()));
    applyTheme("highContrast");
    applyTheme("highContrast");
    applyTheme("bubblePopNight", document.createElement("div"));
    applyTheme("bubblePop");
    stop();
    applyTheme("bubblePopNight");
    expect(seen).toEqual(["highContrast", "bubblePop"]);
    expect(shownTheme()).toBe("bubblePopNight");
    applyTheme("bubblePop");
  });
});
