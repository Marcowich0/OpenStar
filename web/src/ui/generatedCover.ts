// A generated cover (spec #242, "Generated covers"): what a Song without a
// cover image shows wherever a cover goes. Pure and deterministic: the Song's
// tile colour is the base, its Song id picks the pattern and a second palette
// colour, and its title gives the letter. Colours are palette keys and tokens
// until the caller resolves them: `tokenVar` for the DOM (the `Cover`
// component), `readToken` for the canvas (`generatedCoverDataUrl`).

import type { SongDetail } from "../generated/SongDetail";
import {
  PALETTE_KEYS,
  readToken,
  type PaletteKey,
  type TokenRef,
} from "../theme/tokens";

/** What a generated cover is made from: any Song the Library lists. */
export interface CoverSong {
  id: number;
  title: string;
  tileColour: PaletteKey;
}

/** The six Bubble Pop patterns, in the order Song ids step through them. */
export const COVER_PATTERNS = [
  "dots",
  "stripes",
  "waves",
  "stars",
  "bubbles",
  "checks",
] as const;

export type CoverPattern = (typeof COVER_PATTERNS)[number];

export interface GeneratedCover {
  /** The background: the Song's tile colour, as everywhere else it shows. */
  base: PaletteKey;
  /** The pattern's colour: one of the other eleven, from the Song id. */
  accent: PaletteKey;
  pattern: CoverPattern;
  /**
   * The title's first letter (with its accents) or digit, upper case; a
   * note when the title has neither.
   */
  letter: string;
}

export function generatedCover(song: CoverSong): GeneratedCover {
  return {
    base: song.tileColour,
    accent: accentOf(song),
    pattern: COVER_PATTERNS[modulo(song.id, COVER_PATTERNS.length)] ?? "dots",
    letter: letterOf(song.title),
  };
}

function modulo(n: number, m: number): number {
  return ((Math.trunc(n) % m) + m) % m;
}

function accentOf(song: CoverSong): PaletteKey {
  const others = PALETTE_KEYS.filter((key) => key !== song.tileColour);
  return others[mix(song.id) % others.length] ?? song.tileColour;
}

/**
 * An integer hash (Chris Wellons' lowbias32): neighbouring Song ids get
 * unrelated values, so the accent does not step along with the pattern.
 */
function mix(id: number): number {
  let x = Math.trunc(id) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** The mark of a title with no letter or digit. */
const NO_LETTER = "♪";

function letterOf(title: string): string {
  const first = /\p{L}\p{M}*|\p{N}/u.exec(title)?.[0];
  if (first === undefined) return NO_LETTER;
  const upper = first.toUpperCase();
  // "ß" would become "SS": keep a letter whose upper case is two.
  return [...upper].length === [...first].length ? upper : first;
}

export interface CoverSvgOptions {
  /** Turns a palette key or token into a CSS value (`tokenVar`, `readToken`). */
  resolve: (ref: TokenRef) => string;
  /**
   * Draw the letter (the default). An SVG shown as an image cannot use the
   * page's Fredoka, so a canvas leaves it out and draws `cover.letter` itself.
   */
  letter?: boolean;
}

/** The side of the cover's square, in SVG units. */
const SIZE = 100;
/** The disc behind the letter, so it reads over any pattern. */
const DISC_RADIUS = 31;

/**
 * The cover as SVG markup: a square of `SIZE` units that scales to whatever
 * box it is put in. It defines no ids, so any number can share a page.
 */
export function generatedCoverSvg(
  cover: GeneratedCover,
  { resolve, letter = true }: CoverSvgOptions,
): string {
  const paint = (ref: TokenRef) => escapeXml(resolve(ref));
  const accent = paint(cover.accent);
  const parts = [
    `<rect width="${SIZE}" height="${SIZE}" style="fill:${paint(cover.base)}"/>`,
    ...patternMarkup(cover.pattern, accent, paint("--color-white")),
    `<path d="${circle(50, 50, DISC_RADIUS)}" style="fill:${paint(cover.base)}"/>`,
    `<path d="${circle(50, 50, DISC_RADIUS)}" style="fill:none;stroke:${paint("--color-white")};stroke-width:3;stroke-opacity:0.9"/>`,
  ];
  if (letter) {
    const text = (dy: number, colour: string, opacity: number) =>
      `<text x="50" y="${50 + dy}" text-anchor="middle" dominant-baseline="central" style="font-family:${paint("--font-sans")};font-weight:700;font-size:40px;fill:${colour};fill-opacity:${opacity}">${escapeXml(cover.letter)}</text>`;
    parts.push(text(2.5, paint("--color-ink"), 0.25));
    parts.push(text(0, paint("--color-white"), 1));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${parts.join("")}</svg>`;
}

/**
 * A Song's generated cover as an image URL, for the canvas (the sing
 * screen's title card, #264). Resolves the theme's current values by default.
 */
export function generatedCoverDataUrl(
  song: CoverSong,
  { resolve = readToken, letter = true }: Partial<CoverSvgOptions> = {},
): string {
  const svg = generatedCoverSvg(generatedCover(song), { resolve, letter });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function patternMarkup(
  pattern: CoverPattern,
  accent: string,
  white: string,
): string[] {
  const fill = (d: string, opacity = 0.7) =>
    `<path d="${d}" style="fill:${accent};fill-opacity:${opacity}"/>`;
  switch (pattern) {
    case "dots": {
      const dots: string[] = [];
      for (let row = 0; row < 6; row += 1) {
        for (let col = 0; col < 6; col += 1) {
          const x = col * 20 + (row % 2 === 0 ? 0 : 10);
          dots.push(circle(x, row * 20, 4.5));
        }
      }
      return [fill(dots.join(""))];
    }
    case "stripes": {
      const bands: string[] = [];
      for (let x = -100; x < 200; x += 25) {
        bands.push(`M${x} 0H${x + 12}L${x - 88} 100H${x - 100}Z`);
      }
      return [fill(bands.join(""), 0.6)];
    }
    case "waves": {
      const waves: string[] = [];
      for (let y = 8; y < 110; y += 18) {
        waves.push(`M-10 ${y}q6.25 -7 12.5 0t12.5 0t12.5 0t12.5 0t12.5 0t12.5 0t12.5 0t12.5 0t12.5 0t12.5 0`);
      }
      return [
        `<path d="${waves.join("")}" style="fill:none;stroke:${accent};stroke-width:4.5;stroke-linecap:round;stroke-opacity:0.75"/>`,
      ];
    }
    case "stars":
      return [
        fill(
          [
            star(14, 16, 10),
            star(84, 14, 8),
            star(50, 6, 5),
            star(8, 58, 6),
            star(92, 56, 9),
            star(18, 88, 8),
            star(80, 90, 11),
            star(50, 95, 5),
          ].join(""),
          0.8,
        ),
      ];
    case "bubbles": {
      const bubbles: [number, number, number][] = [
        [14, 18, 12],
        [82, 12, 9],
        [92, 48, 7],
        [10, 62, 8],
        [26, 92, 10],
        [76, 84, 14],
        [50, 4, 5],
      ];
      return [
        fill(bubbles.map(([x, y, r]) => circle(x, y, r)).join(""), 0.65),
        `<path d="${bubbles.map(([x, y, r]) => circle(x - r * 0.4, y - r * 0.4, r * 0.25)).join("")}" style="fill:${white};fill-opacity:0.8"/>`,
      ];
    }
    case "checks": {
      const squares: string[] = [];
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          if ((row + col) % 2 === 0) {
            squares.push(`M${col * 20} ${row * 20}h20v20h-20Z`);
          }
        }
      }
      return [fill(squares.join(""), 0.5)];
    }
  }
}

/** A circle as path data, so a pattern is one path whatever its count. */
function circle(cx: number, cy: number, r: number): string {
  return `M${round(cx - r)} ${round(cy)}a${round(r)} ${round(r)} 0 1 0 ${round(2 * r)} 0a${round(r)} ${round(r)} 0 1 0 ${round(-2 * r)} 0Z`;
}

/** A five-pointed star, points up, as path data. */
function star(cx: number, cy: number, r: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(
      `${round(cx + radius * Math.cos(angle))} ${round(cy + radius * Math.sin(angle))}`,
    );
  }
  return `M${points.join("L")}Z`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The cover's Song from a full Song (`GET /api/songs/{id}`), once loaded. */
export function coverSongOf(detail: SongDetail | undefined): CoverSong | null {
  if (detail === undefined) return null;
  return {
    id: detail.id,
    title: detail.song.headers.title,
    tileColour: detail.media.tileColour,
  };
}
