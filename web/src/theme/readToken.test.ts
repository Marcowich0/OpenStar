// The one token reader, as the canvas uses it: it resolves a palette key or a
// token name to the value of its CSS custom property on the document, at call
// time. Runs in jsdom with the real theme loaded as a stylesheet.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import tokensCss from "./tokens.css?raw";
import { readToken, tokenVar, type PaletteKey } from "./tokens";

// jsdom does not know Tailwind's `@theme`; Tailwind emits the same block as
// `:root` custom properties, so load it that way.
const themeCss = tokensCss.replace(/@theme static/, ":root");

let style: HTMLStyleElement;

beforeEach(() => {
  style = document.createElement("style");
  style.textContent = themeCss;
  document.head.append(style);
});

afterEach(() => {
  style.remove();
  document.documentElement.removeAttribute("style");
});

describe("readToken", () => {
  it("resolves a palette key to its Party colour", () => {
    expect(readToken("tangerine").toLowerCase()).toBe("#ff7a1a");
  });

  it("resolves an interface token by name", () => {
    expect(readToken("--color-ink").toLowerCase()).toBe("#2b2d42");
    expect(readToken("--ease-spring")).toBe(
      "cubic-bezier(0.34, 1.56, 0.64, 1)",
    );
  });

  it("follows a custom property changed at runtime, with no rebuild", () => {
    document.documentElement.style.setProperty(
      "--color-party-cherry",
      "rgb(1, 2, 3)",
    );
    expect(readToken("cherry")).toBe("rgb(1, 2, 3)");
  });
});

describe("palette keys in state", () => {
  it("hold no colour value; the DOM and the canvas resolve the key", () => {
    const state: { members: { name: string; colour: PaletteKey }[] } = {
      members: [
        { name: "Mia", colour: "cherry" },
        { name: "Jonas", colour: "forest" },
      ],
    };

    expect(JSON.stringify(state)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(state.members.map((m) => tokenVar(m.colour))).toEqual([
      "var(--color-party-cherry)",
      "var(--color-party-forest)",
    ]);
    expect(state.members.map((m) => readToken(m.colour).toLowerCase())).toEqual(
      ["#ff4b5c", "#146b3a"],
    );
  });
});
