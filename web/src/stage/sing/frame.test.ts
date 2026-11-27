import { afterEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import { isPaletteKey, TOKEN_NAMES } from "../../theme/tokens";
import {
  frame,
  singVoices,
  type BackgroundEntry,
  type DrawEntry,
  type PillEntry,
  type SingState,
} from "./frame";
import { confettiBurst, ParticlePool } from "./effects";
import { laneLayout } from "./laneLayout";
import { LineRatings } from "./lineRating";
import { THEMES } from "../../theme/themes";
import type { SingBackground } from "./background";
import { DEFAULT_SING_LOOK, singLayout, type SingLook } from "./singLook";

// One Beat lasts 0.5 s (beatsPerMinute is the real rate, #BPM × 4); Beat 0
// falls at 1 s. Beat b starts at Song time 1 + b / 2.
const grid = { gapSeconds: 1, beatsPerMinute: 120 };
/**
 * The mechanics tests draw at 88 px per second, 44 px per Beat on this grid,
 * so the whole test Song fits in the lane; the default scale has its own tests.
 */
const PX_PER_BEAT = 44;

function note(
  kind: NoteKind,
  start: number,
  length: number,
  pitch: number,
): Note {
  return { kind, start, length, pitch, text: "la ", line: 1 };
}

const notes = [
  note("normal", 4, 2, 0),
  note("golden", 8, 4, 4),
  note("rap", 12, 1, 2),
  note("freestyle", 14, 2, 6),
  note("goldenRap", 17, 2, 2),
  note("normal", 60, 2, 0), // far right of the lane at the start
];

function song(voices: Note[][]): ParsedSong {
  return {
    headers: grid as ParsedSong["headers"],
    voices: voices.map((n) => ({ lines: [{ notes: n, end: null }] })),
  };
}

function state(
  lanes: SingState["lanes"],
  voices: Note[][] = [notes],
): SingState {
  return { grid, voices: singVoices(song(voices)), lanes };
}

const BLOBS: SingBackground = { kind: "blobs", still: false };

const solo = state([{ colour: "cherry", voice: 0 }]);
const oneLane = laneLayout(1).map((lane) => ({
  ...lane,
  pixelsPerSecond: PX_PER_BEAT * 2,
}));
/** The default Note speed: 420 px per second, whatever the BPM. */
const defaultLane = laneLayout(1);

function pills(list: readonly DrawEntry[], lane = 0): PillEntry[] {
  return list.filter(
    (e): e is PillEntry => e.type === "pill" && e.lane === lane,
  );
}

function pillFor(list: readonly DrawEntry[], start: number, lane = 0) {
  const pill = pills(list, lane).find((p) => p.note.start === start);
  if (!pill) throw new Error(`no pill for the Note at Beat ${String(start)}`);
  return pill;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frame", () => {
  it("is pure: the same inputs give an equal draw list, with no clock or DOM read", () => {
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("frame read the clock");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("frame read the clock");
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("frame read the DOM");
    });
    const frozen = Object.freeze(structuredClone(solo));
    const first = frame(frozen, 3.25, oneLane);
    const second = frame(frozen, 3.25, oneLane);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("draws one lane rectangle and one playhead per lane, in the lane's colour", () => {
    const list = frame(solo, 3, oneLane);
    expect(list.filter((e) => e.type === "lane")).toEqual([
      {
        type: "lane",
        lane: 0,
        x: 60,
        y: 702,
        width: 1800,
        height: 170,
        notesX: 320,
        radius: 40,
        colour: "cherry",
        fill: { colour: "--color-surface", alpha: 0.66, blur: 16 },
        lost: null,
        separator: {
          x: 318,
          top: 724,
          bottom: 850,
          colour: "--color-ink",
          alpha: 0.12,
          width: 2,
        },
      },
    ]);
    expect(list.filter((e) => e.type === "playhead")).toEqual([
      {
        type: "playhead",
        lane: 0,
        x: 600,
        top: 702,
        bottom: 872,
        colour: "--color-ink",
        alpha: 0.3,
        width: 4,
        dash: [1, 12],
      },
    ]);
  });

  it("puts a Note starting now exactly on the playhead, with its width from its length", () => {
    // Song time 3 s is Beat 4: the first Note starts on the playhead.
    const pill = pillFor(frame(solo, 3, oneLane), 4);
    expect(pill.x).toBe(600);
    expect(pill.width).toBeCloseTo((2 - 0.2) * PX_PER_BEAT, 9);
    expect(pill.passed).toBe(false);
    // Notes further on sit 44 px per Beat to the right.
    expect(pillFor(frame(solo, 3, oneLane), 8).x).toBe(600 + 4 * PX_PER_BEAT);
  });

  it("scrolls Notes left continuously as Song time runs, between Beats too", () => {
    // 3.25 s is half a Beat after Beat 4.
    expect(pillFor(frame(solo, 3.25, oneLane), 4).x).toBeCloseTo(
      600 - PX_PER_BEAT / 2,
      9,
    );
    expect(pillFor(frame(solo, 4.1, oneLane), 8).x).toBeCloseTo(
      600 + (8 - 6.2) * PX_PER_BEAT,
      9,
    );
  });

  it("scrolls at the same speed in px per second whatever the BPM", () => {
    // Four times the BPM: each Beat is a quarter as long and as wide, and a
    // Note one second ahead still sits 420 px right of the playhead.
    const fast = { ...solo, grid: { gapSeconds: 1, beatsPerMinute: 480 } };
    // Beat 4 starts 1 s after 2 s on the slow grid, Beat 8 1 s after 1 s on the fast one.
    const slowPill = pillFor(frame(solo, 2, defaultLane), 4);
    const fastPill = pillFor(frame(fast, 1, defaultLane), 8);
    expect(slowPill.x).toBeCloseTo(600 + 420, 9);
    expect(fastPill.x).toBeCloseTo(600 + 420, 9);
    // A Beat is 210 px on the slow grid and 52.5 px on the fast one.
    expect(slowPill.width).toBeCloseTo((2 - 0.2) * 210, 9);
    expect(fastPill.width).toBeCloseTo((4 - 0.2) * 52.5, 9);
  });

  it("shows 3 s of Notes ahead of the playhead at the default Note speed", () => {
    // Beat 12 starts at 7 s: at 4 s it is 3 s ahead, at the lane's right edge.
    const at = (t: number) =>
      pills(frame(solo, t, defaultLane)).filter((p) => p.note.start === 12);
    expect(at(4 - 1e-3)).toHaveLength(0);
    expect(at(4 + 1e-6)).toHaveLength(1);
    expect(at(4 + 1e-6)[0]?.x).toBeCloseTo(1860, 2);
  });

  it("places a pill vertically by pitch across the Voice's range ± 2 semitones", () => {
    // Pitches 0 to 6 → range −2 to 8 (10 semitones); lane 170 px, padding 22,
    // so 126 px inside. Pill height 126 / 10 × 1.5 = 18.9 px.
    const list = frame(solo, 3, oneLane);
    const low = pillFor(list, 4); // pitch 0
    expect(low.height).toBeCloseTo(18.9, 9);
    expect(low.y + low.height / 2).toBeCloseTo(872 - 22 - (2 / 10) * 126, 9);
    const high = pillFor(list, 14); // pitch 6
    expect(high.y + high.height / 2).toBeCloseTo(872 - 22 - (8 / 10) * 126, 9);
  });

  it("clamps the pill height to 8–42 px and uses 12 px padding in lanes under 150 px", () => {
    const narrow = state(
      [{ colour: "sky", voice: 0 }],
      [[note("normal", 4, 2, 0), note("normal", 8, 2, 30)]],
    );
    // 4 lanes of 110 px; range −2 to 32 = 34; (110 − 24) / 34 × 1.5 ≈ 3.8 → 8.
    const lanes = laneLayout(4).slice(0, 1);
    const pill = pillFor(frame(narrow, 3, lanes), 4);
    expect(pill.height).toBe(8);
    expect(pill.y + pill.height / 2).toBeCloseTo(
      402 + 110 - 12 - (2 / 34) * 86,
      9,
    );

    const flat = state(
      [{ colour: "sky", voice: 0 }],
      [[note("normal", 4, 2, 0)]],
    );
    // Range 4 semitones in a 170 px lane: 126 / 4 × 1.5 = 47.25 → 42.
    expect(pillFor(frame(flat, 3, oneLane), 4).height).toBe(42);
  });

  it("gives each kind its fill and outline: Normal, golden, Rap dashed, Freestyle hollow", () => {
    // A filled pill's outline is a mark on a bright fill (on-bright: ink in
    // Bubble Pop, still dark in Night); a hollow one sits on the lane, in ink.
    const list = frame(solo, 3, oneLane);
    const normal = pillFor(list, 4);
    expect(normal).toMatchObject({
      kind: "normal",
      fill: { type: "solid", colour: "--color-white" },
      outline: "--color-on-bright",
      dash: [],
    });
    expect(pillFor(list, 8)).toMatchObject({
      kind: "golden",
      fill: {
        type: "vertical",
        top: "--color-golden-top",
        bottom: "--color-golden-bottom",
      },
      outline: "--color-on-bright",
      dash: [],
    });
    const rap = pillFor(list, 12);
    expect(rap).toMatchObject({
      kind: "rap",
      fill: { type: "solid", colour: "--color-white" },
      outline: "--color-on-bright",
    });
    expect(rap.dash).toEqual([2 * rap.outlineWidth, 2 * rap.outlineWidth]);
    expect(pillFor(list, 14)).toMatchObject({
      kind: "freestyle",
      fill: null,
      outline: "--color-ink",
      dash: [],
    });
    const goldenRap = pillFor(list, 17);
    expect(goldenRap).toMatchObject({
      kind: "goldenRap",
      fill: { type: "vertical", top: "--color-golden-top" },
    });
    expect(goldenRap.dash).toHaveLength(2);
  });

  it("sets the outline width by pill height: 2.5 under 14 px, 3.5 under 20, else 4.5", () => {
    const at = (pitches: number[]) =>
      pillFor(
        frame(
          state(
            [{ colour: "sky", voice: 0 }],
            [pitches.map((p, i) => note("normal", 4 + 4 * i, 2, p))],
          ),
          3,
          oneLane,
        ),
        4,
      );
    // 170 px lane, 126 px inside: range r gives height 189 / r.
    expect(at([0, 16]).outlineWidth).toBe(2.5); // 189 / 20 = 9.45
    expect(at([0, 7]).outlineWidth).toBe(3.5); // 189 / 11 ≈ 17.2
    expect(at([0, 2]).outlineWidth).toBe(4.5); // 189 / 6 = 31.5
  });

  it("turns a Note passed once its end crosses the playhead", () => {
    // The first pill ends 1.8 Beats after Beat 4: at Beat 5.8, 3.9 s.
    const before = pillFor(frame(solo, 3.85, oneLane), 4);
    expect(before.passed).toBe(false);
    expect(before.fill).toEqual({ type: "solid", colour: "--color-white" });

    const after = pillFor(frame(solo, 3.95, oneLane), 4);
    expect(after.passed).toBe(true);
    expect(after.fill).toEqual({ type: "solid", colour: "--color-passed" });
    expect(after.outline).toBe("--color-on-bright");

    // A golden Note greys too; a Freestyle Note stays hollow with a grey outline.
    expect(pillFor(frame(solo, 7.5, oneLane), 8).fill).toEqual({
      type: "solid",
      colour: "--color-passed",
    });
    expect(pillFor(frame(solo, 9, oneLane), 14)).toMatchObject({
      passed: true,
      fill: null,
      outline: "--color-passed",
    });
  });

  it("leaves out Notes wholly outside the Notes area", () => {
    // At 3 s, Beat 60 is 56 Beats right of the playhead: x 3064, off the lane.
    expect(pills(frame(solo, 3, oneLane)).map((p) => p.note.start)).toEqual([
      4, 8, 12, 14, 17,
    ]);
    // Much later, the early Notes have scrolled off the left of the Notes area.
    expect(pills(frame(solo, 30, oneLane)).map((p) => p.note.start)).toEqual([
      60,
    ]);
  });

  it("gives each lane its own Voice's Notes in a duet", () => {
    const p2 = [note("normal", 5, 1, 12)];
    const duet = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "teal", voice: 1 },
      ],
      [notes, p2],
    );
    const list = frame(duet, 3, laneLayout(2));
    expect(pills(list, 1).map((p) => p.note)).toEqual(p2);
    expect(pills(list, 0).map((p) => p.note.start)).toContain(4);
    // The second lane's pills sit inside the second lane.
    const pill = pillFor(list, 5, 1);
    expect(pill.y).toBeGreaterThan(732);
    expect(pill.y + pill.height).toBeLessThan(872);
  });

  it("draws every lane of an 8-Player layout", () => {
    const eight = state(
      Array.from({ length: 8 }, (_, i) => ({
        colour: "lime" as const,
        voice: i % 1,
      })),
    );
    const list = frame(eight, 3, laneLayout(8));
    expect(list.filter((e) => e.type === "lane")).toHaveLength(8);
    // 420 × 34 / 44 px per second in two columns; the right column's
    // playhead is at 1350, and the Note at Beat 4 is half a second ahead.
    const twoColumns = (420 * 34) / 44;
    expect(pillFor(frame(eight, 2.5, laneLayout(8)), 4, 4).x).toBeCloseTo(
      1350 + 0.5 * twoColumns,
      9,
    );
  });

  it("draws the pitch grid every 2 semitones across the lane's range, faint ink, 2 px", () => {
    // Pitches 0 to 6 → −2 to 8; 126 px inside, bottom at 850.
    const grids = frame(solo, 3, oneLane).filter((e) => e.type === "grid");
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    expect(grid).toMatchObject({
      lane: 0,
      left: 320,
      right: 1860,
      colour: "--color-ink",
      alpha: 0.07,
      width: 2,
    });
    const ys = grid?.type === "grid" ? grid.ys : [];
    expect(ys).toHaveLength(6);
    [850, 824.8, 799.6, 774.4, 749.2, 724].forEach((y, i) => {
      expect(ys[i]).toBeCloseTo(y, 9);
    });
  });

  it("draws the grid inside the lane's clip, before its pills", () => {
    const types = frame(solo, 3, oneLane).map((e) => e.type);
    expect(types.indexOf("grid")).toBeGreaterThan(types.indexOf("lane"));
    expect(types.indexOf("grid")).toBeLessThan(types.indexOf("pill"));
  });

  it("clips a lane's Notes to its rounded shape: radius min(40, height / 2)", () => {
    const lane = (layout: ReturnType<typeof laneLayout>) =>
      frame(solo, 3, layout).find((e) => e.type === "lane");
    expect(lane(oneLane)).toMatchObject({ radius: 40 });
    const small = [{ ...oneLane[0], height: 60 }] as ReturnType<
      typeof laneLayout
    >;
    expect(lane(small)).toMatchObject({ radius: 30 });
  });

  it("puts a white star near the left end of a golden pill at least 18 px tall", () => {
    // Pill height 18.9 px (see above).
    const golden = pillFor(frame(solo, 3, oneLane), 8);
    expect(golden.star).not.toBeNull();
    expect(golden.star?.colour).toBe("--color-white");
    expect(golden.star?.x).toBeCloseTo(golden.x + golden.height / 2, 9);
    expect(golden.star?.y).toBeCloseTo(golden.y + golden.height / 2, 9);
    expect(golden.star?.outer).toBeLessThan(golden.height / 2);
    // Normal pills have none; nor does a golden pill under 18 px.
    expect(pillFor(frame(solo, 3, oneLane), 4).star).toBeNull();
    const short = state(
      [{ colour: "sky", voice: 0 }],
      [[note("golden", 4, 2, 0), note("normal", 8, 2, 7)]],
    ); // 189 / 11 ≈ 17.2 px
    expect(pillFor(frame(short, 3, oneLane), 4).star).toBeNull();
    // A passed golden pill is grey and loses its star.
    expect(pillFor(frame(solo, 7.5, oneLane), 8).star).toBeNull();
  });

  it("sweeps a shimmer band across each golden pill left to right every 1.5 s from its start, until it passes", () => {
    const band = (t: number) => pillFor(frame(solo, t, oneLane), 8).shimmer;
    const at = (t: number) => {
      const pill = pillFor(frame(solo, t, oneLane), 8);
      const s = pill.shimmer;
      if (!s) throw new Error("no shimmer");
      // Where the band is across its sweep: 0 entering left, 1 leaving right.
      return (s.x - pill.x + s.width) / (pill.width + s.width);
    };
    // The golden Note at Beat 8 starts at 5 s; each pill sweeps in its own phase.
    expect(band(3)).toMatchObject({ colour: "--color-white" });
    expect(at(3)).toBeCloseTo(2 / 3, 9);
    expect(at(5)).toBeCloseTo(0, 9);
    expect(at(5.75)).toBeCloseTo(0.5, 9);
    expect(at(6.125)).toBeCloseTo(0.75, 9);
    expect(at(6.5)).toBeCloseTo(0, 9);
    // Normal and passed pills do not shimmer; golden Rap does.
    expect(pillFor(frame(solo, 3, oneLane), 4).shimmer).toBeNull();
    expect(pillFor(frame(solo, 3, oneLane), 17).shimmer).not.toBeNull();
    expect(band(7.5)).toBeNull();
  });

  it("draws the progress bar across the top: 80 px in, 20 px down, about 10 px tall, with room for the time left", () => {
    // The last Note ends at Beat 62: Song time 1 + 62 / 2 = 32 s.
    const progress = (t: number, s: SingState = solo) =>
      frame(s, t, oneLane).filter((e) => e.type === "progress");
    expect(progress(16)).toEqual([
      {
        type: "progress",
        x: 80,
        y: 20,
        width: 1660,
        height: 10,
        fraction: 0.5,
        track: "--color-white",
        trackAlpha: 0.5,
        fill: "--color-yellow",
      },
    ]);
    expect(progress(-3)[0]).toMatchObject({ fraction: 0 });
    expect(progress(40)[0]).toMatchObject({ fraction: 1 });
    // The Song's own length wins over the last Note's end.
    expect(progress(10, { ...solo, lengthSeconds: 40 })[0]).toMatchObject({
      fraction: 0.25,
    });
  });

  it("ends with the live particles of the state's effects, drawn but not moved by Song time", () => {
    const effects = new ParticlePool(8, { gravity: 0 });
    effects.spawn(500, 400, 100, 0, 0, 2, 12, "star", "cherry", 0);
    effects.advance(0.25);
    const particle = {
      type: "particle",
      x: 525,
      y: 400,
      size: 12,
      shape: "star",
      colour: "cherry",
      rotation: 0,
      alpha: 1,
    };
    const at3 = frame({ ...solo, particles: effects }, 3, oneLane);
    expect(at3.at(-1)).toEqual(particle);
    expect(frame({ ...solo, particles: effects }, 9, oneLane).at(-1)).toEqual(
      particle,
    );
    expect(at3.filter((e) => e.type === "particle")).toHaveLength(1);
    expect(frame(solo, 3, oneLane).some((e) => e.type === "particle")).toBe(
      false,
    );
  });

  it("names colours only by palette key or token, never by a colour value", () => {
    const duet = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "grape", voice: 0 },
      ],
      [notes],
    );
    const effects = new ParticlePool(64);
    confettiBurst(effects, 300, 300, "grape");
    const ratings = new LineRatings();
    ratings.show(1, "sing.lineRating.good");
    const colours: unknown[] = [];
    for (const t of [3, 3.95, 9]) {
      for (const entry of frame(
        { ...duet, particles: effects, ratings, background: BLOBS },
        t,
        laneLayout(2),
      )) {
        switch (entry.type) {
          case "lane":
            colours.push(entry.colour, entry.separator.colour);
            break;
          case "playhead":
            colours.push(entry.colour);
            break;
          case "pill":
            colours.push(entry.outline);
            if (entry.fill?.type === "solid") colours.push(entry.fill.colour);
            if (entry.fill?.type === "vertical")
              colours.push(entry.fill.top, entry.fill.bottom);
            if (entry.star) colours.push(entry.star.colour);
            if (entry.shimmer) colours.push(entry.shimmer.colour);
            break;
          case "pitchLine":
            colours.push(entry.hit.colour, entry.hit.edge, entry.miss.colour);
            break;
          case "headBall":
            colours.push(entry.colour, entry.rim);
            break;
          case "lyric":
            colours.push(entry.colour);
            break;
          case "grid":
            colours.push(entry.colour);
            break;
          case "progress":
            colours.push(entry.track, entry.fill);
            break;
          case "particle":
          case "lineRating":
            colours.push(entry.colour);
            break;
          case "lyricBar":
            colours.push(entry.fill.colour);
            break;
          case "titleCard":
            colours.push(entry.fill, entry.ledge, entry.cover.tile);
            colours.push(entry.cover.rim, entry.title.colour);
            colours.push(entry.artist.colour);
            break;
          case "pauseHint":
            colours.push(entry.fill, entry.text.colour);
            break;
          case "timeLeft":
            colours.push(entry.text.colour, entry.outline);
            break;
          case "background":
            if (entry.kind === "blobs") {
              colours.push(entry.base, ...entry.blobs.map((b) => b.colour));
            }
            break;
          case "laneEnd":
            break;
        }
      }
    }
    expect(colours.length).toBeGreaterThan(10);
    const known = new Set<unknown>(TOKEN_NAMES);
    for (const colour of colours) {
      expect(isPaletteKey(colour) || known.has(colour), String(colour)).toBe(
        true,
      );
    }
  });
});

describe("the lyric bar and the lane frosting (Stage options)", () => {
  const look = (change: Partial<SingLook>): SingLook => ({
    lyricSize: "m",
    showNextLine: true,
    laneFrostingPercent: 66,
    ...change,
  });
  const players = (count: number) =>
    Array.from({ length: count }, () => ({
      colour: "cherry" as const,
      voice: 0,
    }));
  function drawn(s: SingState) {
    const list = frame(s, 3, singLayout(s));
    const bar = list.find((e) => e.type === "lyricBar");
    if (!bar) throw new Error("no lyric bar");
    const lanes = list.filter((e) => e.type === "lane");
    return { bar, lanes };
  }

  it("sizes the lyric bar by Lyric size, xl 1.5 × m, growing upward from 34 px above the bottom", () => {
    // #55's m: a 78 px Line and a 36 px next Line, line height 1.1, and
    // 10 + 16 px of padding.
    const sizes = [
      ["s", 62.4, 28.8, 126.32],
      ["m", 78, 36, 151.4],
      ["l", 97.5, 45, 182.75],
      ["xl", 117, 54, 214.1],
    ] as const;
    for (const [lyricSize, line, next, height] of sizes) {
      const { bar } = drawn({ ...solo, look: look({ lyricSize }) });
      expect(bar.lineSize, lyricSize).toBeCloseTo(line);
      expect(bar.nextSize, lyricSize).toBeCloseTo(next);
      expect(bar.height, lyricSize).toBeCloseTo(height);
      expect(bar.bottom, lyricSize).toBe(1046);
      expect(bar.top, lyricSize).toBeCloseTo(1046 - height);
    }
  });

  it("draws the lyric bar at m with the next Line when the state has no look", () => {
    expect(drawn(solo).bar).toMatchObject({ lineSize: 78, nextSize: 36 });
  });

  it("leaves the next Line out when Show next Line is off, and the bar is shorter", () => {
    const { bar } = drawn({ ...solo, look: look({ showNextLine: false }) });
    expect(bar.nextSize).toBeNull();
    expect(bar.height).toBeCloseTo(111.8);
  });

  it("shows no next Line in a duet, whose two current Lines are 60 px at m", () => {
    const duet = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "grape", voice: 1 },
      ],
      [notes, notes],
    );
    const { bar } = drawn(duet);
    expect(bar).toMatchObject({ lineSize: 60, lines: 2, nextSize: null });
    expect(bar.height).toBeCloseTo(158);
  });

  it("fills the lane panels with white at the Lane frosting's alpha", () => {
    for (const [laneFrostingPercent, alpha] of [
      [40, 0.4],
      [66, 0.66],
      [90, 0.9],
    ] as const) {
      const { lanes } = drawn({
        ...state(players(2)),
        look: look({ laneFrostingPercent }),
      });
      for (const lane of lanes) {
        expect(lane.fill).toEqual({
          colour: "--color-surface",
          alpha,
          blur: 16,
        });
      }
    }
  });

  it("keeps the lanes where they are at m and s, whatever the Players", () => {
    for (const lyricSize of ["s", "m"] as const) {
      for (const count of [1, 2, 4, 8]) {
        const s = { ...state(players(count)), look: look({ lyricSize }) };
        expect(singLayout(s)).toEqual(laneLayout(count));
      }
    }
  });

  it("at 4 Players and xl, moves the lanes up above the lyric bar, keeping their heights and gaps", () => {
    const s = { ...state(players(4)), look: look({ lyricSize: "xl" }) };
    const { bar, lanes } = drawn(s);
    expect(lanes).toHaveLength(4);
    const m = laneLayout(4);
    const top = lanes[0]?.y ?? 0;
    lanes.forEach((lane, i) => {
      expect(lane.y + lane.height, `lane ${String(i)}`).toBeLessThanOrEqual(
        bar.top,
      );
      expect(lane.height).toBe(m[i]?.height);
      expect(lane.y - top).toBe((m[i]?.y ?? 0) - (m[0]?.y ?? 0));
    });
    // Moved up, but still clear of the progress bar along the top.
    expect(top).toBeLessThan(m[0]?.y ?? 0);
    expect(top).toBeGreaterThan(40);
  });

  it("keeps every lane clear of the lyric bar at every size, Player count and duet", () => {
    for (const lyricSize of ["s", "m", "l", "xl"] as const) {
      for (const showNextLine of [true, false]) {
        for (const count of [1, 2, 3, 4, 5, 8]) {
          for (const voices of [[notes], [notes, notes]]) {
            const s = {
              ...state(players(count), voices),
              look: look({ lyricSize, showNextLine }),
            };
            const { bar, lanes } = drawn(s);
            for (const lane of lanes) {
              expect(lane.y + lane.height).toBeLessThanOrEqual(bar.top);
            }
          }
        }
      }
    }
  });
});

describe("the theme's sing screen", () => {
  const bubblePop = THEMES.bubblePop.sing;
  const highContrast = THEMES.highContrast.sing;
  const twoPlayers = state([
    { colour: "cherry", voice: 0 },
    { colour: "sky", voice: 0 },
  ]);
  const at66 = { ...twoPlayers, look: { ...DEFAULT_SING_LOOK } };

  function lanesOf(list: readonly DrawEntry[]) {
    return list.filter((e) => e.type === "lane");
  }

  it("frosts the lanes in Bubble Pop: the surface at the Lane frosting option, 16 px of blur", () => {
    for (const lane of lanesOf(frame(at66, 3, singLayout(at66), bubblePop))) {
      expect(lane.fill).toEqual({
        colour: "--color-surface",
        alpha: 0.66,
        blur: 16,
      });
    }
  });

  it("draws Bubble Pop when no theme is given", () => {
    expect(frame(at66, 3, singLayout(at66))).toEqual(
      frame(at66, 3, singLayout(at66), bubblePop),
    );
  });

  it("makes the lanes solid in High contrast, whatever the Lane frosting option, with no blur", () => {
    for (const laneFrostingPercent of [40, 66, 90]) {
      const s = {
        ...twoPlayers,
        look: { ...DEFAULT_SING_LOOK, laneFrostingPercent },
      };
      for (const lane of lanesOf(frame(s, 3, singLayout(s), highContrast))) {
        expect(lane.fill).toEqual({
          colour: "--color-surface",
          alpha: 1,
          blur: 0,
        });
      }
    }
  });

  it("makes the lyric bar solid with no blur in High contrast; frosted at 86 % with 14 px of blur in Bubble Pop", () => {
    const bar = (theme: typeof bubblePop) =>
      frame(solo, 3, singLayout(solo), theme).find(
        (e) => e.type === "lyricBar",
      );
    expect(bar(bubblePop)?.fill).toEqual({
      colour: "--color-surface",
      alpha: 0.86,
      blur: 14,
    });
    expect(bar(highContrast)?.fill).toEqual({
      colour: "--color-surface",
      alpha: 1,
      blur: 0,
    });
  });

  it("draws every ink edge 1.5 × as thick in High contrast: pill outlines and Rap dashes", () => {
    const pillsIn = (theme: typeof bubblePop) =>
      pills(frame(solo, 3, oneLane, theme));
    const plain = pillsIn(bubblePop);
    const thick = pillsIn(highContrast);
    expect(thick).toHaveLength(plain.length);
    thick.forEach((pill, i) => {
      const width = plain[i]?.outlineWidth ?? NaN;
      expect(pill.outlineWidth).toBeCloseTo(width * 1.5);
      if (pill.kind === "rap" || pill.kind === "goldenRap") {
        expect(pill.dash).toEqual([3 * width, 3 * width]);
      }
    });
  });

  it("draws the grid, the separator and the playhead darker in High contrast", () => {
    const faint = (theme: typeof bubblePop) => {
      const list = frame(solo, 3, oneLane, theme);
      const grid = list.find((e) => e.type === "grid");
      const lane = list.find((e) => e.type === "lane");
      const playhead = list.find((e) => e.type === "playhead");
      return [grid?.alpha, lane?.separator.alpha, playhead?.alpha];
    };
    expect(faint(bubblePop)).toEqual([0.07, 0.12, 0.3]);
    const [grid, separator, playhead] = faint(highContrast);
    expect(grid).toBeGreaterThanOrEqual(0.15);
    expect(separator).toBeGreaterThanOrEqual(0.3);
    expect(playhead).toBeGreaterThanOrEqual(0.6);
  });
});

describe("the background layer (ticket 263)", () => {
  function background(list: readonly DrawEntry[]): BackgroundEntry {
    const entry = list.find((e) => e.type === "background");
    if (!entry) throw new Error("no background entry");
    return entry;
  }
  function blobs(list: readonly DrawEntry[]) {
    const entry = background(list);
    if (entry.kind !== "blobs") throw new Error(`a ${entry.kind} background`);
    return entry.blobs;
  }

  it("comes first, below everything else, and names its kind", () => {
    for (const kind of ["video", "image", "blobs"] as const) {
      const list = frame(
        { ...solo, background: { kind, still: false } },
        3,
        oneLane,
      );
      expect(list[0]).toMatchObject({ type: "background", kind });
      expect(list.filter((e) => e.type === "background")).toHaveLength(1);
    }
  });

  it("leaves the video and the image to the DOM: their entry carries nothing to paint", () => {
    const list = frame(
      { ...solo, background: { kind: "image", still: false } },
      3,
      oneLane,
    );
    expect(background(list)).toEqual({ type: "background", kind: "image" });
  });

  it("has none without a background in the state", () => {
    expect(frame(solo, 3, oneLane).some((e) => e.type === "background")).toBe(
      false,
    );
  });

  it("draws large soft blobs in the Line-up's Party colours, in lane order, on cream", () => {
    const two = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "teal", voice: 1 },
      ],
      [notes, notes],
    );
    const list = frame({ ...two, background: BLOBS }, 3, laneLayout(2));
    expect(background(list)).toMatchObject({ base: "--color-cream" });
    const colours = blobs(list).map((b) => b.colour);
    // At least three blobs: the Line-up's colours, again as needed.
    expect(colours).toEqual(["cherry", "teal", "cherry"]);
    for (const blob of blobs(list)) {
      expect(blob.radius).toBeGreaterThanOrEqual(400);
    }
  });

  it("adds a slate blob for a Voice that several Players share", () => {
    const shared = state([
      { colour: "cherry", voice: 0 },
      { colour: "grape", voice: 0 },
      { colour: "lime", voice: 0 },
    ]);
    const list = frame({ ...shared, background: BLOBS }, 3, laneLayout(3));
    expect(blobs(list).map((b) => b.colour)).toEqual([
      "cherry",
      "grape",
      "lime",
      "--color-slate",
    ]);
  });

  it("gives every Player of an 8-Player Line-up a blob", () => {
    const keys = [
      "cherry",
      "sky",
      "navy",
      "cocoa",
      "teal",
      "lime",
      "berry",
      "mint",
    ] as const;
    const eight = state(
      keys.map((colour, i) => ({ colour, voice: i % 2 })),
      [notes, notes],
    );
    const list = frame({ ...eight, background: BLOBS }, 3, laneLayout(8));
    expect(blobs(list).map((b) => b.colour)).toEqual([
      ...keys,
      "--color-slate",
      "--color-slate",
    ]);
  });

  it("moves the blobs slowly with Song time: a little in a frame, more over seconds", () => {
    const at = (t: number) =>
      blobs(frame({ ...solo, background: BLOBS }, t, oneLane));
    const now = at(10);
    const nextFrame = at(10 + 1 / 60);
    const later = at(14);
    for (let i = 0; i < now.length; i++) {
      const a = now[i];
      const b = nextFrame[i];
      const c = later[i];
      if (!a || !b || !c) throw new Error("blob missing");
      const step = Math.hypot(b.x - a.x, b.y - a.y);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(2);
      expect(Math.hypot(c.x - a.x, c.y - a.y)).toBeGreaterThan(20);
    }
  });

  it("keeps the blobs still when the background says so (Effects off, reduced motion)", () => {
    const still: SingState = {
      ...solo,
      background: { kind: "blobs", still: true },
    };
    expect(blobs(frame(still, 2, oneLane))).toEqual(
      blobs(frame(still, 47.5, oneLane)),
    );
  });
});
