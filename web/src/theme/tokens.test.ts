// Pins the default theme: the twelve Party colours in palette order and the
// Bubble Pop interface tokens, with the values of v1 spec: Visual direction
// and Stage screens (#55). This file and `tokens.css` are the only places a
// colour literal may appear (see `checks/colourLiterals.ts`).

import { describe, expect, it } from "vitest";

import tokensCss from "./tokens.css?raw";
import {
  PALETTE_KEYS,
  PARTY_COLOUR_TOKENS,
  TOKEN_NAMES,
  themeDeclarations,
} from "./tokens";

// Prettier writes hex in lower case; the spec writes it in upper case.
const declarations = new Map(
  [...themeDeclarations(tokensCss)].map(([name, value]) => [
    name,
    value.replace(/#[0-9a-f]+/gi, (hex) => hex.toUpperCase()),
  ]),
);

describe("Party colours", () => {
  it("are exactly the twelve palette keys, in palette order", () => {
    expect(PALETTE_KEYS).toEqual([
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
    ]);
  });

  it("map each key to a token with the default theme's hex value", () => {
    const values = PALETTE_KEYS.map((key) => [
      key,
      declarations.get(PARTY_COLOUR_TOKENS[key]),
    ]);
    expect(values).toEqual([
      ["cherry", "#FF4B5C"],
      ["sky", "#2EA8FF"],
      ["navy", "#1F3F9E"],
      ["cocoa", "#7A3E12"],
      ["teal", "#12BFC4"],
      ["lime", "#9BD62B"],
      ["berry", "#8B1457"],
      ["mint", "#3DDC84"],
      ["bubblegum", "#FF6FB5"],
      ["forest", "#146B3A"],
      ["grape", "#9B5CFF"],
      ["tangerine", "#FF7A1A"],
    ]);
  });

  it("are defined in the same order in the theme", () => {
    const party = [...declarations.keys()].filter((name) =>
      name.startsWith("--color-party-"),
    );
    expect(party).toEqual(PALETTE_KEYS.map((key) => PARTY_COLOUR_TOKENS[key]));
  });
});

describe("interface tokens", () => {
  it("have the Bubble Pop values", () => {
    expect(Object.fromEntries(declarations)).toMatchObject({
      "--color-cream": "#FFF6E9",
      "--color-cream-2": "#FFE7CC",
      "--color-ink": "#2B2D42",
      "--color-ink-2": "#5D6079",
      "--color-mute": "#8A8CA0",
      "--color-ledge": "rgba(43, 45, 66, 0.14)",
      "--color-red": "#FF4B5C",
      "--color-red-ledge": "#C7303F",
      "--color-blue": "#2EA8FF",
      "--color-green": "#3DDC84",
      "--color-green-ledge": "#24A862",
      "--color-yellow": "#FFC93C",
      "--color-yellow-ledge": "#D9A21A",
      "--color-ink-ledge": "#14151F",
      "--color-purple": "#9B5CFF",
      "--color-slate": "#7C82A0",
      "--color-golden-top": "#FFE58A",
      "--color-golden-bottom": "#FFB020",
      "--color-passed": "#ECEDF5",
      "--color-warn-bg": "#FFE1E4",
      "--color-warn-fg": "#B3192B",
      "--color-veil": "rgba(43, 45, 66, 0.4)",
      "--color-blob-blue": "#CDEBFF",
      "--color-blob-pink": "#FFD6DC",
      "--color-blob-green": "#D9F7E6",
      "--color-lane-ledge": "rgba(43, 45, 66, 0.18)",
      "--color-lane-shadow": "rgba(0, 0, 0, 0.18)",
      "--color-golden-text": "#E09A00",
      "--color-lyric-ledge": "rgba(43, 45, 66, 0.2)",
      "--color-mic-lost-ledge": "rgba(0, 0, 0, 0.25)",
      "--color-fit-low": "hsl(0 75% 55%)",
      "--color-fit-high": "hsl(120 75% 55%)",
      "--color-white": "#FFFFFF",
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
      "--default-transition-timing-function": "var(--ease-spring)",
    });
  });

  it("make every ledge a solid shadow 6 to 10 px straight down", () => {
    const ledges = [...declarations].filter(([name]) =>
      name.startsWith("--shadow-"),
    );
    expect(ledges.length).toBeGreaterThan(0);
    for (const [name, value] of ledges) {
      const match = /^0 (\d+)px 0 var\(--color-[\w-]+\)$/.exec(value);
      expect(match, name).not.toBeNull();
      const offset = Number(match?.[1]);
      expect(offset, name).toBeGreaterThanOrEqual(6);
      expect(offset, name).toBeLessThanOrEqual(10);
    }
  });

  it("keep golden yellow, passed grey and slate out of the Party colours", () => {
    const partyValues = PALETTE_KEYS.map((key) =>
      declarations.get(PARTY_COLOUR_TOKENS[key]),
    );
    for (const token of [
      "--color-yellow",
      "--color-golden-top",
      "--color-golden-bottom",
      "--color-passed",
      "--color-slate",
    ]) {
      expect(partyValues).not.toContain(declarations.get(token));
    }
  });

  it("keep the interface accents apart from the Party colours", () => {
    // Red and cherry share a value but are two tokens: changing one leaves the other.
    expect(declarations.get("--color-red")).toBe(
      declarations.get(PARTY_COLOUR_TOKENS.cherry),
    );
    expect(TOKEN_NAMES).toContain("--color-red");
    expect(TOKEN_NAMES).toContain("--color-party-cherry");
  });
  it("are exactly the token names the reader knows", () => {
    expect([...declarations.keys()].sort()).toEqual([...TOKEN_NAMES].sort());
  });
});

describe("motion", () => {
  it("animates with the Bubble Pop keyframes and only those", () => {
    expect(
      Object.fromEntries(
        [...declarations].filter(([name]) => name.startsWith("--animate-")),
      ),
    ).toEqual({
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
      "--animate-toast-in":
        "toast-in var(--motion-spring) var(--ease-spring) both",
      "--animate-fade-in": "fade-in var(--motion-fade) ease-out both",
      "--animate-fade-out": "fade-out var(--motion-fade) ease-in both",
    });
  });

  it("has the spring durations, easings and sizes of the motion pass", () => {
    expect(
      Object.fromEntries(
        [...declarations].filter(
          ([name]) => name.startsWith("--motion-") || name.startsWith("--ease-"),
        ),
      ),
    ).toEqual({
      "--ease-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      "--ease-exit": "cubic-bezier(0.36, 0, 0.66, -0.56)",
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
    });
  });

  it("bounces the focus ring 1 → 1.06 → 1", () => {
    expect(keyframes("focus-bounce")).toMatch(
      /40%\s*\{\s*scale:\s*var\(--motion-focus-scale\);\s*\}/,
    );
  });

  it("springs an overlay in from, and out to, its smaller size", () => {
    for (const name of ["overlay-in", "overlay-out"]) {
      expect(keyframes(name)).toMatch(
        /\{\s*scale:\s*var\(--motion-overlay-scale\);\s*opacity:\s*0;\s*\}/,
      );
    }
  });

  it("drops a toast in from above", () => {
    expect(keyframes("toast-in")).toMatch(
      /from\s*\{\s*translate:\s*0 var\(--motion-toast-drop\);\s*opacity:\s*0;\s*\}/,
    );
  });

  it("breathes up to 6 % larger", () => {
    expect(keyframes("breathe")).toMatch(/50%\s*\{\s*scale:\s*1\.06;\s*\}/);
  });

  it("pops in from small, overshooting through the spring easing", () => {
    expect(keyframes("pop-in")).toMatch(
      /from\s*\{\s*scale:\s*0\.6;\s*opacity:\s*0;\s*\}/,
    );
  });

  it("lets a toast leave by fading upward", () => {
    expect(keyframes("toast-out")).toMatch(
      /to\s*\{\s*translate:\s*0 -14px;\s*scale:\s*0\.9;\s*opacity:\s*0;\s*\}/,
    );
  });

  it("pops a new lyric Line in from 24 px lower at 96 % size over 0.35 s", () => {
    expect(keyframes("line-in")).toMatch(
      /from\s*\{\s*translate:\s*0 24px;\s*scale:\s*0\.96;\s*opacity:\s*0;\s*\}/,
    );
  });

  it("squashes and stretches the selected carousel cover, then rests", () => {
    expect(keyframes("squish")).toMatch(
      /0%\s*\{\s*scale:\s*0\.88 1\.12;\s*\}\s*45%\s*\{\s*scale:\s*1\.08 0\.92;\s*\}/,
    );
  });

  it("bobs the logo's star by tilting and growing it", () => {
    expect(keyframes("bob")).toMatch(
      /50%\s*\{\s*rotate:\s*14deg;\s*scale:\s*1\.1;\s*\}/,
    );
  });

  it("shakes 12 px to each side and back", () => {
    const offsets = [
      ...keyframes("shake").matchAll(/translate:\s*(-?\d+)px/g),
    ].map((match) => Number(match[1]));
    expect(Math.max(...offsets)).toBe(12);
    expect(Math.min(...offsets)).toBe(-12);
  });
});

describe("motion with fades (reduced motion or Effects off)", () => {
  const fade = fadeDeclarations();
  const animations = [...declarations].filter(([name]) =>
    name.startsWith("--animate-"),
  );

  it("turns every spring duration into the 120 ms fade", () => {
    expect(declarations.get("--motion-fade")).toBe("120ms");
    const durations = [...declarations].filter(
      ([name, value]) => name.startsWith("--motion-") && /ms$/.test(value),
    );
    expect(durations.length).toBeGreaterThan(1);
    for (const [name] of durations) {
      if (name === "--motion-fade") continue;
      expect(fade.get(name), name).toBe("var(--motion-fade)");
    }
  });

  it("leaves every size where it is", () => {
    expect(fade.get("--motion-press-scale")).toBe("1");
    expect(fade.get("--motion-focus-scale")).toBe("1");
    expect(fade.get("--motion-overlay-scale")).toBe("1");
    expect(fade.get("--motion-toast-drop")).toBe("0px");
    expect(fade.get("--motion-sheet-rise")).toBe("0px");
  });

  it("runs no animation that scales, moves or turns", () => {
    expect(animations.length).toBeGreaterThan(0);
    for (const [name, value] of animations) {
      const shown = fade.get(name) ?? value;
      if (shown === "none") continue;
      const keyframe = /^var\((--animate-[\w-]+)\)$/.exec(shown)?.[1];
      const used = keyframe === undefined ? shown : declarations.get(keyframe);
      const keyframeName = used?.split(" ")[0] ?? "";
      expect(keyframes(keyframeName), name).not.toMatch(
        /\b(scale|translate|rotate|transform):/,
      );
    }
  });

  it("fades, rather than stops, whatever enters or leaves", () => {
    for (const name of [
      "--animate-pop-in",
      "--animate-line-in",
      "--animate-overlay-in",
      "--animate-toast-in",
    ]) {
      expect(fade.get(name), name).toBe("var(--animate-fade-in)");
    }
    for (const name of ["--animate-overlay-out", "--animate-toast-out"]) {
      expect(fade.get(name), name).toBe("var(--animate-fade-out)");
    }
    expect(keyframes("fade-in")).toMatch(/from\s*\{\s*opacity:\s*0;\s*\}/);
    expect(keyframes("fade-out")).toMatch(/to\s*\{\s*opacity:\s*0;\s*\}/);
  });

  it("only redefines motion tokens", () => {
    for (const name of fade.keys()) {
      expect(name).toMatch(/^--(motion|animate)-/);
      expect(declarations.has(name), name).toBe(true);
    }
  });
});

/** The declarations of the `:root[data-motion="fade"]` block. */
function fadeDeclarations(): Map<string, string> {
  const block =
    /:root\[data-motion="fade"\]\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "";
  expect(block).not.toBe("");
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map(
    [...withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name ?? "", (value ?? "").trim()],
    ),
  );
}

function keyframes(name: string): string {
  const start = tokensCss.indexOf(`@keyframes ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = tokensCss.indexOf("\n  }", start);
  return tokensCss.slice(start, end);
}
