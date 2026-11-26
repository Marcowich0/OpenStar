import { describe, expect, it } from "vitest";

import type { BeatGrid } from "../clock/beats";
import type { Note } from "../generated/Note";
import { LOOP, loopRange, loopSeek } from "./loop";

/** 60 Beats a minute, `#GAP` 0: Beat b starts at b seconds. */
const grid: BeatGrid = { gapSeconds: 0, beatsPerMinute: 60 };

function note(start: number, length: number): Note {
  return { kind: "normal", start, length, pitch: 0, text: "la", line: 1 };
}

// Voice 1: Lines at 10–14, 20–23 and 30–32 s; Voice 2: one Line at 40–41 s.
const song = {
  voices: [
    {
      lines: [
        { notes: [note(10, 2), note(13, 1)] },
        { notes: [note(20, 3)] },
        { notes: [note(30, 2)] },
      ],
    },
    { lines: [{ notes: [note(40, 1)] }] },
  ],
};

describe("the range L loops", () => {
  it("runs from 1.5 s before a Line to 0.6 s after it", () => {
    expect(LOOP).toEqual({ beforeSeconds: 1.5, afterSeconds: 0.6 });
  });

  it("loops the selected Line", () => {
    const selection = { voice: 0, anchor: 1, first: 1, last: 1 };
    expect(loopRange(song, grid, selection, 0)).toEqual({
      start: 18.5,
      end: 23.6,
    });
  });

  it("loops a selected range of Lines from its first to its last", () => {
    const selection = { voice: 0, anchor: 2, first: 0, last: 2 };
    expect(loopRange(song, grid, selection, 0)).toEqual({
      start: 8.5,
      end: 32.6,
    });
  });

  it("loops the Line at the playhead without a selection", () => {
    expect(loopRange(song, grid, null, 21)).toEqual({ start: 18.5, end: 23.6 });
    expect(loopRange(song, grid, null, 40.5)).toEqual({
      start: 38.5,
      end: 41.6,
    });
  });

  it("between Lines, loops the next Line, and after the last the last", () => {
    expect(loopRange(song, grid, null, 16)).toEqual({ start: 18.5, end: 23.6 });
    expect(loopRange(song, grid, null, 50)).toEqual({ start: 38.5, end: 41.6 });
  });

  it("never starts before the Song", () => {
    const early = { voices: [{ lines: [{ notes: [note(1, 1)] }] }] };
    expect(loopRange(early, grid, null, 0)).toEqual({ start: 0, end: 2.6 });
  });

  it("has nothing to loop in a Song without Notes", () => {
    expect(loopRange({ voices: [] }, grid, null, 0)).toBeNull();
  });
});

describe("going round the loop", () => {
  const range = { start: 18.5, end: 23.6 };

  it("seeks back to the start once Song time reaches the end", () => {
    expect(loopSeek(23.6, range)).toBe(18.5);
    expect(loopSeek(24, range)).toBe(18.5);
  });

  it("lets it play inside the range", () => {
    expect(loopSeek(18.5, range)).toBeNull();
    expect(loopSeek(23.59, range)).toBeNull();
  });
});
