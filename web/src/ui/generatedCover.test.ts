import { describe, expect, it } from "vitest";

import { PALETTE_KEYS, tokenVar } from "../theme/tokens";
import {
  generatedCover,
  generatedCoverDataUrl,
  generatedCoverSvg,
  type CoverSong,
} from "./generatedCover";

function song(id: number, title = "Sunny Day"): CoverSong {
  return { id, title, tileColour: "sky" };
}

describe("generatedCover", () => {
  it("gives the same Song the same cover every time", () => {
    expect(generatedCover(song(7))).toEqual(generatedCover(song(7)));
  });

  it("gives the fixture Library's Songs at least four different patterns", () => {
    // `fixtures/library/` holds five `.txt` files; a first scan gives them the
    // Song ids 1 to 5 (one row each in `library_files`), one of them the
    // rejected file. Whichever it is, the four playable Songs differ.
    const titles = ["Separate Video", "Sine Melody", "Steady Tone", "Two Voices"];
    for (let rejected = 1; rejected <= 5; rejected += 1) {
      const ids = [1, 2, 3, 4, 5].filter((id) => id !== rejected);
      const patterns = new Set(
        ids.map((id, i) => generatedCover(song(id, titles[i])).pattern),
      );
      expect(patterns.size).toBeGreaterThanOrEqual(4);
    }
  });

  it("is based on the Song's tile colour, with a second palette colour beside it", () => {
    const cover = generatedCover({ id: 3, title: "A", tileColour: "berry" });
    expect(cover.base).toBe("berry");
    expect(PALETTE_KEYS).toContain(cover.accent);
    expect(cover.accent).not.toBe("berry");
  });

  it("picks the second colour from the Song id, using every other palette colour", () => {
    const accents = new Set<string>();
    for (let id = 1; id <= 300; id += 1) {
      const cover = generatedCover({ id, title: "A", tileColour: "teal" });
      expect(cover.accent).not.toBe("teal");
      accents.add(cover.accent);
    }
    expect(accents.size).toBe(11);
  });

  it.each([
    ["Sunny Day", "S"],
    ["night song", "N"],
    ["éclair", "É"],
    ["99 Luftballons", "9"],
    ["(I Can't Get No) Satisfaction", "I"],
    ['"Heroes"', "H"],
    ["...Baby One More Time", "B"],
    ["  Spaced", "S"],
    ["¡Hola!", "H"],
    ["Ölmeyen", "Ö"],
    ["ß", "ß"],
  ])("shows the title's first letter or digit: %j → %j", (title, letter) => {
    expect(generatedCover(song(1, title)).letter).toBe(letter);
  });

  it("shows a note when the title has no letter or digit", () => {
    expect(generatedCover(song(1, "!!!")).letter).toBe("♪");
    expect(generatedCover(song(1, "")).letter).toBe("♪");
  });

  it("uses all six patterns, and six Songs indexed in a row never repeat one", () => {
    for (let first = 1; first < 100; first += 1) {
      const patterns = new Set(
        [0, 1, 2, 3, 4, 5].map((n) => generatedCover(song(first + n)).pattern),
      );
      expect(patterns).toEqual(
        new Set(["dots", "stripes", "waves", "stars", "bubbles", "checks"]),
      );
    }
  });
});

describe("generatedCoverSvg", () => {
  const berry = { id: 4, title: "Sunny Day", tileColour: "berry" } as const;

  it("paints with palette keys and tokens the theme resolves, never a hex colour", () => {
    const asked = new Set<string>();
    const svg = generatedCoverSvg(generatedCover(berry), {
      resolve: (ref) => {
        asked.add(ref);
        return `[${ref}]`;
      },
    });
    const cover = generatedCover(berry);
    expect(asked).toContain("berry");
    expect(asked).toContain(cover.accent);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // Every colour in the markup is one the theme resolved (or none).
    for (const [, value] of svg.matchAll(/(?:fill|stroke|color):([^;"]+)/g)) {
      expect(value).toMatch(/^(\[[\w-]+\]|none)$/);
    }
  });

  it("draws the title's letter", () => {
    const svg = generatedCoverSvg(generatedCover(berry), { resolve: tokenVar });
    expect(svg).toMatch(/<text[^>]*>S<\/text>/);
    expect(svg).toContain("var(--font-sans)");
  });

  it("can leave the letter out, for a canvas that draws it in Fredoka itself", () => {
    const svg = generatedCoverSvg(generatedCover(berry), {
      resolve: tokenVar,
      letter: false,
    });
    expect(svg).not.toContain("<text");
  });

  it("draws each pattern differently", () => {
    const drawn = new Set(
      [1, 2, 3, 4, 5, 6].map((id) =>
        generatedCoverSvg(generatedCover({ ...berry, id }), {
          resolve: () => "c",
          letter: false,
        }),
      ),
    );
    expect(drawn.size).toBe(6);
  });

  it("escapes what the theme resolves, such as a quoted font family", () => {
    const svg = generatedCoverSvg(generatedCover(berry), {
      resolve: (ref) => (ref === "--font-sans" ? '"Fredoka", sans-serif' : "c"),
    });
    expect(svg).toContain("&quot;Fredoka&quot;, sans-serif");
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror")).toBeNull();
  });
});

describe("generatedCoverDataUrl", () => {
  it("is the cover's SVG as an image URL, for the sing screen's canvas", () => {
    const song = { id: 4, title: "Sunny Day", tileColour: "berry" } as const;
    const url = generatedCoverDataUrl(song, { resolve: () => "red", letter: false });
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(
      generatedCoverSvg(generatedCover(song), { resolve: () => "red", letter: false }),
    );
  });
});
