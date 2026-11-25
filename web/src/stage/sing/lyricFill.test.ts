import { describe, expect, it } from "vitest";

import type { Line } from "../../generated/Line";
import type { Note } from "../../generated/Note";
import type { ParsedSong } from "../../generated/ParsedSong";
import {
  frame,
  singVoices,
  type DrawEntry,
  type LyricEntry,
  type SingState,
} from "./frame";
import { laneLayout } from "./laneLayout";

// One Beat lasts 0.5 s; Beat b starts at Song time 1 + b / 2.
const grid = { gapSeconds: 1, beatsPerMinute: 120 };

function note(start: number, length: number, text: string): Note {
  return { kind: "normal", start, length, pitch: 0, text, line: 1 };
}

// Line 1: Beats 4–6 and 8–12, switching to Line 2 at Beat 16.
// Line 2: Beats 20–22 and 24–26, the Voice's last Line.
const lines: Line[] = [
  {
    notes: [note(4, 2, "Hel"), note(8, 4, "lo ")],
    end: { beat: 16, line: 3 },
  },
  { notes: [note(20, 2, "a"), note(24, 2, "gain")], end: null },
];
const duetLines: Line[] = [{ notes: [note(10, 2, "oh ")], end: null }];

function state(lanes: SingState["lanes"], duet = false): SingState {
  const song = {
    headers: grid,
    voices: duet ? [{ lines }, { lines: duetLines }] : [{ lines }],
  } as unknown as ParsedSong;
  return { grid, voices: singVoices(song), lanes };
}

/** Song time at Beat `b`. */
const at = (b: number) => 1 + b / 2;

function lyrics(s: SingState, beat: number): LyricEntry[] {
  return frame(s, at(beat), laneLayout(s.lanes.length)).filter(
    (e: DrawEntry): e is LyricEntry => e.type === "lyric",
  );
}

const solo = state([{ colour: "cherry", voice: 0 }]);

describe("the lyric fill in frame()", () => {
  it("has the first Line and no current Note before the first Note", () => {
    expect(lyrics(solo, 0)).toEqual([
      {
        type: "lyric",
        voice: 0,
        line: 0,
        note: -1,
        fraction: 0,
        singing: false,
        colour: "cherry",
      },
    ]);
  });

  it("fills the current Note by how much of it has been sung", () => {
    expect(lyrics(solo, 9)[0]).toMatchObject({
      line: 0,
      note: 1,
      fraction: 0.25,
      singing: true,
    });
    expect(lyrics(solo, 4.5)[0]).toMatchObject({
      note: 0,
      fraction: 0.25,
      singing: true,
    });
  });

  it("keeps a sung Note full until the next one starts", () => {
    expect(lyrics(solo, 7)[0]).toMatchObject({
      line: 0,
      note: 0,
      fraction: 1,
      singing: false,
    });
    expect(lyrics(solo, 14)[0]).toMatchObject({
      line: 0,
      note: 1,
      fraction: 1,
      singing: false,
    });
  });

  it("moves to the next Line at the Line end marker's Beat", () => {
    expect(lyrics(solo, 15.5)[0]).toMatchObject({ line: 0, note: 1 });
    expect(lyrics(solo, 16)[0]).toMatchObject({
      line: 1,
      note: -1,
      fraction: 0,
    });
    expect(lyrics(solo, 25)[0]).toMatchObject({
      line: 1,
      note: 1,
      fraction: 0.5,
    });
  });

  it("stays on the last Line after the Song's last Note", () => {
    expect(lyrics(solo, 100)[0]).toMatchObject({
      line: 1,
      note: 1,
      fraction: 1,
      singing: false,
    });
  });

  it("fills a Note with no length at once when it starts", () => {
    const s = state([{ colour: "cherry", voice: 0 }]);
    const zero = singVoices({
      voices: [{ lines: [{ notes: [note(4, 0, "ha")], end: null }] }],
    });
    const z = { ...s, voices: zero };
    expect(lyrics(z, 3)[0]).toMatchObject({ note: -1, fraction: 0 });
    expect(lyrics(z, 4)[0]).toMatchObject({ note: 0, fraction: 1 });
  });
});

describe("the lyric fill colour", () => {
  it("is the Player's Party colour when one Player sings the Voice", () => {
    expect(lyrics(solo, 9)[0]?.colour).toBe("cherry");
  });

  it("is slate when two or more Players share the Voice", () => {
    const shared = state([
      { colour: "cherry", voice: 0 },
      { colour: "teal", voice: 0 },
    ]);
    expect(lyrics(shared, 9)[0]?.colour).toBe("--color-slate");
  });

  it("is worked out per Voice in a duet", () => {
    const duet = state(
      [
        { colour: "cherry", voice: 0 },
        { colour: "teal", voice: 1 },
        { colour: "sky", voice: 1 },
      ],
      true,
    );
    const entries = lyrics(duet, 11);
    expect(entries.map((e) => [e.voice, e.colour])).toEqual([
      [0, "cherry"],
      [1, "--color-slate"],
    ]);
    expect(entries[1]).toMatchObject({
      line: 0,
      note: 0,
      fraction: 0.5,
      singing: true,
    });
  });
});
