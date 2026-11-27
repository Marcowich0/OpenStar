import { describe, expect, it } from "vitest";

import beatsFixture from "../../../fixtures/scoring/beats.json?raw";
import { beatAt, beatBoundaries, beatStart, type BeatGrid } from "./beats";

interface BeatAtCase extends BeatGrid {
  name: string;
  songTime: number;
  beat: number;
}

interface NoteTimeCase extends BeatGrid {
  name: string;
  beat: number;
  songTime: number;
}

const fixture = JSON.parse(beatsFixture) as {
  beatAt: BeatAtCase[];
  noteTimes: NoteTimeCase[];
};

describe("beatAt over GAP and BPM", () => {
  it.each(fixture.beatAt)("$name", (c) => {
    expect(beatAt(c, c.songTime)).toBe(c.beat);
  });
});

describe("a Note's Song time (Vincent fix)", () => {
  it.each(fixture.noteTimes)("$name", (c) => {
    expect(beatStart(c, c.beat)).toBeCloseTo(c.songTime, 8);
    // The fixture's Song time is rounded, so check the Beat at the exact start.
    expect(beatAt(c, beatStart(c, c.beat))).toBe(c.beat);
  });

  it("moves the same Note when GAP and BPM change", () => {
    const [before400, after400] = fixture.noteTimes;
    if (!before400 || !after400) throw new Error("fixture is missing cases");
    const before = beatStart(before400, 400);
    const after = beatStart(after400, 400);
    expect(before - after).toBeCloseTo(31.248896044 - 28.497381763, 8);
  });
});

describe("Beat boundaries", () => {
  const vincent: BeatGrid = { gapSeconds: 0.753, beatsPerMinute: 865.04 };

  it("a Beat's own start always maps back to that Beat, the moment before to the previous one", () => {
    for (let b = -50; b <= 3000; b++) {
      const start = beatStart(vincent, b);
      expect(beatAt(vincent, start)).toBe(b);
      expect(beatAt(vincent, start - 1e-9)).toBe(b - 1);
    }
  });

  it("lists the starts of a Beat range plus the end of its last Beat", () => {
    const grid: BeatGrid = { gapSeconds: 0.5, beatsPerMinute: 480 };
    expect(beatBoundaries(grid, 2, 4)).toEqual([0.75, 0.875, 1, 1.125]);
  });

  it("every Song time inside a listed span maps to that span's Beat", () => {
    const boundaries = beatBoundaries(vincent, 100, 140);
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const start = boundaries[i] ?? NaN;
      const end = boundaries[i + 1] ?? NaN;
      expect(beatAt(vincent, start)).toBe(100 + i);
      expect(beatAt(vincent, (start + end) / 2)).toBe(100 + i);
      expect(beatAt(vincent, end)).toBe(101 + i);
    }
  });
});
