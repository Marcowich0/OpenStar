// The 24 built-in avatar icons: one bundled SVG per avatar key, all drawn
// the same way (a silhouette under `#glyph`, optional ink marks under
// `#detail`, no colours or text of their own), each distinct.

import { describe, expect, it } from "vitest";

import { AVATAR_KEYS, avatarIconUrl } from "./avatarIcons";

// The set as the ticket (#112) and spec #48 list it.
const THE_24 = [
  "star",
  "heart",
  "moon",
  "bolt",
  "note",
  "crown",
  "drop",
  "leaf",
  "diamond",
  "cloud",
  "flame",
  "ghost",
  "sun",
  "planet",
  "rocket",
  "cat",
  "fish",
  "flower",
  "mushroom",
  "apple",
  "guitar",
  "headphones",
  "rainbow",
  "butterfly",
];

const files = import.meta.glob<string>("./*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

function fileOf(key: string): string {
  return files[`./${key}.svg`] ?? "";
}

describe("avatar icons", () => {
  it("are the 24 built-in keys", () => {
    expect([...AVATAR_KEYS].sort()).toEqual([...THE_24].sort());
  });

  it("are one SVG file per key and no other", () => {
    const names = Object.keys(files)
      .map((file) => file.slice(2, -4))
      .sort();
    expect(names).toEqual([...THE_24].sort());
  });

  it.each(THE_24)("%s has a glyph to fill and outline", (key) => {
    const svg = fileOf(key);
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 64 64"/);
    expect(svg).toContain('id="glyph"');
    expect(svg).toContain('id="detail"');
  });

  it.each(THE_24)("%s carries no colour, outline or text of its own", (key) => {
    const svg = fileOf(key);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
    expect(svg).not.toMatch(/\b(fill|stroke)="(?!none")/);
    expect(svg).not.toMatch(/stroke-width|style=|<text|<image/);
  });

  it("are each distinct", () => {
    const bodies = THE_24.map((key) => fileOf(key).replace(/\s+/g, " "));
    expect(new Set(bodies).size).toBe(24);
  });

  it("are referenced by the file's glyph and detail fragments", () => {
    expect(avatarIconUrl("star", "glyph")).toMatch(/star\.svg#glyph$/);
    expect(avatarIconUrl("moon", "detail")).toMatch(/moon\.svg#detail$/);
  });
});
