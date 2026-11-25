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
      "--color-white": "#FFFFFF",
      "--radius-card-sm": "36px",
      "--radius-card": "44px",
      "--radius-card-lg": "52px",
      "--shadow-ledge-sm": "0 6px 0 var(--color-ledge)",
      "--shadow-ledge": "0 8px 0 var(--color-ledge)",
      "--shadow-ledge-lg": "0 10px 0 var(--color-ledge)",
      "--ease-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
    });
  });

  it("are exactly the token names the reader knows", () => {
    expect([...declarations.keys()].sort()).toEqual([...TOKEN_NAMES].sort());
  });
});
