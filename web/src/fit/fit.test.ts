import { describe, expect, it } from "vitest";

import type { NoteKind } from "../generated/NoteKind";
import matchCasesText from "../../../fixtures/fit/match-cases.json?raw";
import melodyText from "../../../fixtures/fit/melody.json?raw";
import type { Voice } from "../generated/Voice";
import {
  createMatcher,
  fitNotesOf,
  overviewHue,
  type FitNote,
  type LineRef,
} from "./fit";
import { renderTrack, type SungSong } from "./syntheticTrack";

interface MatchCase {
  name: string;
  kind: NoteKind;
  pitch: number;
  frameHz: number;
  share: number | null;
}

const matchCases = (JSON.parse(matchCasesText) as { cases: MatchCase[] }).cases;

/** One Beat lasts 60 / 6000 s = 10 ms, exactly one frame. */
const FRAME_GRID = { gapSeconds: 0, beatsPerMinute: 6000 };

function note(fields: Partial<FitNote>): FitNote {
  return {
    voice: 0,
    line: 0,
    kind: "normal",
    start: 0,
    length: 1,
    pitch: 9,
    ...fields,
  };
}

describe("match measure: hand-built cases (fixtures/fit/match-cases.json)", () => {
  it.each(matchCases)("$name", (c) => {
    const matcher = createMatcher({
      pitch: new Float32Array(20).fill(c.frameHz),
    });
    const n = note({ kind: c.kind, pitch: c.pitch, start: 5, length: 10 });
    expect(matcher.noteShare(n, FRAME_GRID)).toBe(c.share);
  });
});

/** A track of `frames` frames, A4 (440 Hz) on the frames listed, unvoiced elsewhere. */
function a4On(frames: number, voiced: number[]) {
  const pitch = new Float32Array(frames);
  for (const i of voiced) pitch[i] = 440;
  return { pitch };
}

describe("match measure: the frames a Note covers", () => {
  it("covers round(t0 / 0.01) to round(t1 / 0.01)", () => {
    // [0.034, 0.076) covers frames 3 to 8: five frames, two of them sung.
    const matcher = createMatcher(a4On(10, [2, 3, 4, 8]));
    const grid = { gapSeconds: 0.034, beatsPerMinute: 6000 };
    expect(matcher.noteShare(note({ length: 4.2 }), grid)).toBeCloseTo(
      2 / 5,
      12,
    );
  });

  it("is clamped to the end of the track", () => {
    // [0.08, 0.2) on a 10-frame track covers frames 8 and 9.
    const matcher = createMatcher(a4On(10, [9]));
    expect(matcher.noteShare(note({ start: 8, length: 12 }), FRAME_GRID)).toBe(
      1 / 2,
    );
  });

  it("is clamped to the start of the track", () => {
    const matcher = createMatcher(a4On(10, [0, 1]));
    expect(matcher.noteShare(note({ start: -4, length: 8 }), FRAME_GRID)).toBe(
      2 / 4,
    );
  });

  it("covers at least one frame", () => {
    const matcher = createMatcher(a4On(10, [0, 1, 2, 3]));
    // Past the end of the track: no frame, counted as one unmatched frame.
    expect(matcher.noteShare(note({ start: 30, length: 3 }), FRAME_GRID)).toBe(
      0,
    );
    // Shorter than half a frame: rounds to no frame.
    expect(matcher.noteShare(note({ start: 2, length: 0.2 }), FRAME_GRID)).toBe(
      0,
    );
  });
});

describe("match measure: Line and Song shares", () => {
  // Frames 0-9 sung; Line 0 has a one-frame Note on the singing and a four-frame
  // Note in silence, Line 1 a two-frame Note on the singing.
  const matcher = createMatcher(a4On(30, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const notes = [
    note({ line: 0, start: 0, length: 1 }),
    note({ line: 0, start: 12, length: 4 }),
    note({ line: 0, kind: "rap", start: 20, length: 6 }),
    note({ line: 1, start: 5, length: 2 }),
    note({ line: 1, kind: "freestyle", start: 20, length: 6 }),
  ];

  it("sums matching frames over covered frames, not the mean of Note shares", () => {
    expect(matcher.share(notes.slice(0, 3), FRAME_GRID)).toBe(1 / 5);
    expect(matcher.share(notes, FRAME_GRID)).toBe(3 / 7);
  });

  it("is null when no Note counts", () => {
    expect(
      matcher.share([notes[2] as FitNote, notes[4] as FitNote], FRAME_GRID),
    ).toBeNull();
  });

  it("gives every Line its share, in file order, with the Voice", () => {
    const duet = [...notes, note({ voice: 1, line: 0, kind: "rap" })];
    expect(matcher.lineShares(duet, FRAME_GRID)).toEqual([
      { voice: 0, line: 0, share: 1 / 5 },
      { voice: 0, line: 1, share: 1 },
      { voice: 1, line: 0, share: null },
    ]);
  });
});

/** `#GAP` (ms) and `#BPM` as a file writes them. */
interface FileTiming {
  gap: number;
  bpm: number;
}

interface ExpectedFit extends FileTiming {
  /** The file's own values, exactly ("Already the best fit"). */
  exact?: boolean;
}

interface FitCase {
  description: string;
  file: FileTiming;
  sung: SungSong;
  seconds: number;
  melody: string;
  expect: {
    fitToTheSinging?: ExpectedFit;
    offsetOnly?: ExpectedFit;
    lineSuggestions?: (LineRef & { beats: number })[];
  };
}

const melody = (JSON.parse(melodyText) as { notes: FitNote[] }).notes;

const caseFiles = import.meta.glob<string>("../../../fixtures/fit/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const fitCases = Object.entries(caseFiles)
  .map(([path, text]) => ({
    fixture: path.split("/").pop() ?? path,
    ...(JSON.parse(text) as FitCase),
  }))
  .filter((c) => "melody" in c && c.melody === "melody.json");

const gridOf = (t: FileTiming) => ({
  gapSeconds: t.gap / 1000,
  beatsPerMinute: t.bpm * 4,
});

describe("fit cases (fixtures/fit/*.json)", () => {
  it("finds every case", () => {
    expect(fitCases.map((c) => c.fixture).sort()).toEqual([
      "already-best-fit.json",
      "gap-and-bpm-error.json",
      "gap-error.json",
      "one-line-late.json",
    ]);
  });

  describe.each(fitCases)("$fixture", (c) => {
    const matcher = createMatcher(renderTrack(melody, c.sung, c.seconds));
    const fileGrid = gridOf(c.file);

    const fits = [
      ["Fit to the singing", c.expect.fitToTheSinging, true],
      ["offset only", c.expect.offsetOnly, false],
    ] as const;
    for (const [name, expected, tempo] of fits) {
      if (!expected) continue;
      it(`${name} gives #GAP ${String(expected.gap)} and #BPM ${String(expected.bpm)}`, () => {
        const before = matcher.share(melody, fileGrid) ?? 0;
        const fit = matcher.fitToTheSinging(melody, fileGrid, { tempo });
        const gap = fit.gapSeconds * 1000;
        const bpm = fit.beatsPerMinute / 4;
        if (expected.exact === true) {
          expect({
            gapSeconds: fit.gapSeconds,
            beatsPerMinute: fit.beatsPerMinute,
          }).toEqual(fileGrid);
          expect(fit.share).toBe(before);
        } else {
          expect(Math.abs(gap - expected.gap)).toBeLessThanOrEqual(10);
          expect(Math.abs(bpm - expected.bpm)).toBeLessThanOrEqual(0.01);
          expect(fit.share).toBeGreaterThan(before);
        }
        // GAP in whole milliseconds, BPM in hundredths; offset only keeps the BPM as written.
        expect(Number.isInteger(Math.round(gap * 1e6) / 1e6)).toBe(true);
        expect(Math.round(bpm * 100) / 100).toBeCloseTo(bpm, 9);
        if (!tempo) expect(fit.beatsPerMinute).toBe(fileGrid.beatsPerMinute);
        expect(fit.share).toBe(matcher.share(melody, fit));
      });
    }

    const suggestions = c.expect.lineSuggestions;
    if (suggestions) {
      it(`suggests ${String(suggestions.length)} Line(s)`, () => {
        const found = matcher.lineSuggestions(melody, fileGrid);
        expect(
          found.map(({ voice, line, beats }) => ({ voice, line, beats })),
        ).toEqual(suggestions);
        for (const f of found) {
          expect(f.shareAfter - f.shareBefore).toBeGreaterThanOrEqual(0.2);
          expect(f.shareAfter).toBeGreaterThanOrEqual(0.5);
          expect(f.shareBefore).toBe(
            matcher.share(
              melody.filter((n) => n.line === f.line),
              fileGrid,
            ),
          );
        }
      });
    }
  });
});

describe("Line suggestions: when a Line is suggested", () => {
  // One Beat lasts 100 ms; Line 0 is one Note on Beats 10-20 (1.0-2.0 s), Line 1 one
  // Note on Beats 40-50 (4.0-5.0 s). The track sings A4 where each case says.
  const grid = { gapSeconds: 0, beatsPerMinute: 600 };
  const lines = [
    note({ line: 0, start: 10, length: 10 }),
    note({ line: 1, start: 40, length: 10 }),
  ];
  const sung = (ranges: [number, number][]) => {
    const pitch = new Float32Array(700);
    for (const [from, to] of ranges) pitch.fill(440, from, to);
    return createMatcher({ pitch });
  };

  it("names the Line sung late, with the Beats to move it and the shares", () => {
    // Line 0 sung 7 Beats (700 ms) late; Line 1 on time.
    const found = sung([
      [170, 270],
      [400, 500],
    ]).lineSuggestions(lines, grid);
    expect(found).toEqual([
      { voice: 0, line: 0, beats: 7, shareBefore: 0.3, shareAfter: 1 },
    ]);
  });

  it("names a Line sung early with negative Beats", () => {
    const found = sung([
      [100, 200],
      [280, 380],
    ]).lineSuggestions(lines, grid);
    expect(found).toEqual([
      { voice: 0, line: 1, beats: -12, shareBefore: 0, shareAfter: 1 },
    ]);
  });

  it("does not look further than 1.5 s", () => {
    // Line 1 sung 2.6 s late.
    expect(
      sung([
        [100, 200],
        [660, 700],
      ]).lineSuggestions(lines, grid),
    ).toEqual([]);
  });

  it("rounds the move to whole Beats and drops a move of 0 Beats", () => {
    // Ten one-Beat Notes sung 40 ms late: 60 % before, 100 % at +40 ms, which is 0 Beats.
    const short = Array.from({ length: 10 }, (_, i) =>
      note({ start: 10 + 2 * i, length: 1 }),
    );
    const pitch = new Float32Array(400);
    for (let i = 0; i < 10; i++) pitch.fill(440, 104 + 20 * i, 114 + 20 * i);
    expect(createMatcher({ pitch }).lineSuggestions(short, grid)).toEqual([]);
  });

  it("needs the share to rise by at least 0.20", () => {
    // Sung 2 Beats late: 80 % before, 100 % after: a rise of 0.20 is enough, 0.10 is not.
    expect(
      sung([[120, 220]]).lineSuggestions(lines.slice(0, 1), grid),
    ).toHaveLength(1);
    expect(sung([[110, 210]]).lineSuggestions(lines.slice(0, 1), grid)).toEqual(
      [],
    );
  });

  it("needs the new share to be at least 0.50", () => {
    // Half of the Line is sung, 1 s late: 0 → 0.5 is enough; 0 → 0.4 is not.
    expect(sung([[200, 250]]).lineSuggestions(lines.slice(0, 1), grid)).toEqual(
      [{ voice: 0, line: 0, beats: 5, shareBefore: 0, shareAfter: 0.5 }],
    );
    expect(sung([[200, 240]]).lineSuggestions(lines.slice(0, 1), grid)).toEqual(
      [],
    );
  });

  it("never suggests a Line with no Note that counts", () => {
    const rap = [note({ kind: "rap", start: 10, length: 10 })];
    expect(sung([[170, 270]]).lineSuggestions(rap, grid)).toEqual([]);
  });
});

describe("overview colour", () => {
  it.each([
    [0, 0],
    [0.3125, 60],
    [0.5, 96],
    [0.625, 120],
    [0.9, 120],
    [1, 120],
  ])("share %f is hue %f (red 0 to green 120)", (share, hue) => {
    expect(overviewHue(share)).toBeCloseTo(hue, 9);
  });
});

describe("fitNotesOf", () => {
  it("takes every Note of a parsed Song in file order, with its Voice and Line", () => {
    const parsed = (kind: NoteKind, start: number, pitch: number) => ({
      kind,
      start,
      length: 2,
      pitch,
      text: "la ",
      line: 7,
    });
    const voices: Voice[] = [
      {
        lines: [
          { notes: [parsed("normal", 0, 4), parsed("rap", 2, 5)], end: null },
          { notes: [parsed("golden", 8, 6)], end: null },
        ],
      },
      { lines: [{ notes: [parsed("freestyle", 1, -2)], end: null }] },
    ];
    expect(fitNotesOf({ voices })).toEqual([
      { voice: 0, line: 0, kind: "normal", start: 0, length: 2, pitch: 4 },
      { voice: 0, line: 0, kind: "rap", start: 2, length: 2, pitch: 5 },
      { voice: 0, line: 1, kind: "golden", start: 8, length: 2, pitch: 6 },
      { voice: 1, line: 0, kind: "freestyle", start: 1, length: 2, pitch: -2 },
    ]);
  });
});
