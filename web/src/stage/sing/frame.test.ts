import { afterEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import { isPaletteKey, TOKEN_NAMES } from "../../theme/tokens";
import {
  frame,
  singVoices,
  type DrawEntry,
  type PillEntry,
  type SingState,
} from "./frame";
import { laneLayout } from "./laneLayout";

// One Beat lasts 0.5 s (beatsPerMinute is the real rate, #BPM × 4); Beat 0
// falls at 1 s. Beat b starts at Song time 1 + b / 2.
const grid = { gapSeconds: 1, beatsPerMinute: 120 };

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

const solo = state([{ colour: "cherry", voice: 0 }]);
const oneLane = laneLayout(1);

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
        colour: "cherry",
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
    expect(pill.width).toBeCloseTo((2 - 0.2) * 44, 9);
    expect(pill.passed).toBe(false);
    // Notes further on sit 44 px per Beat to the right.
    expect(pillFor(frame(solo, 3, oneLane), 8).x).toBe(600 + 4 * 44);
  });

  it("scrolls Notes left continuously as Song time runs, between Beats too", () => {
    // 3.25 s is half a Beat after Beat 4.
    expect(pillFor(frame(solo, 3.25, oneLane), 4).x).toBeCloseTo(600 - 22, 9);
    expect(pillFor(frame(solo, 4.1, oneLane), 8).x).toBeCloseTo(
      600 + (8 - 6.2) * 44,
      9,
    );
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
    const list = frame(solo, 3, oneLane);
    const normal = pillFor(list, 4);
    expect(normal).toMatchObject({
      kind: "normal",
      fill: { type: "solid", colour: "--color-white" },
      outline: "--color-ink",
      dash: [],
    });
    expect(pillFor(list, 8)).toMatchObject({
      kind: "golden",
      fill: {
        type: "vertical",
        top: "--color-golden-top",
        bottom: "--color-golden-bottom",
      },
      outline: "--color-ink",
      dash: [],
    });
    const rap = pillFor(list, 12);
    expect(rap).toMatchObject({
      kind: "rap",
      fill: { type: "solid", colour: "--color-white" },
      outline: "--color-ink",
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
    expect(after.outline).toBe("--color-ink");

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
    // 34 px per Beat in two columns; the right column's playhead is at 1350.
    expect(pillFor(list, 8, 4).x).toBe(1350 + 4 * 34);
  });

  it("names colours only by palette key or token, never by a colour value", () => {
    const duet = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "grape", voice: 0 },
      ],
      [notes],
    );
    const colours: unknown[] = [];
    for (const t of [3, 3.95, 9]) {
      for (const entry of frame(duet, t, laneLayout(2))) {
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
            break;
          case "pitchLine":
            colours.push(entry.hit.colour, entry.hit.edge, entry.miss.colour);
            break;
          case "headBall":
            colours.push(entry.colour, entry.rim);
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
