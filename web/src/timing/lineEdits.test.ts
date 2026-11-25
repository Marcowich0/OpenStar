import { describe, expect, it } from "vitest";

import { describeEdit } from "./describeEdit";
import {
  moveNote,
  nudgeLines,
  setNoteLength,
  shiftLines,
  stretchLines,
} from "./lineEdits";
import { selectLine, extendSelection } from "./selection";
import { commitAt, must, song } from "./testSong";
import {
  currentTiming,
  openTimingModel,
  operationsOf,
  redo,
  undo,
  type TimingModel,
} from "./timingModel";

/** Each Line's Notes as `[start, length]`, and its Line end Beat. */
function shape(model: TimingModel) {
  return currentTiming(model).song.voices[0]?.lines.map((line) => ({
    notes: line.notes.map((n) => [n.start, n.length]),
    end: line.end?.beat ?? null,
  }));
}

/** Lines 1–2 (0-based) of the test Song: Notes at 40, 44, 80, 84. */
const lines1to2 = extendSelection(selectLine({ voice: 0, line: 1 }), {
  voice: 0,
  line: 2,
});

describe("shifting a Line selection", () => {
  it("moves every Note start in it by the same whole Beats, Line breaks inside with them", () => {
    const model = openTimingModel(song(4));
    const shifted = commitAt(model, shiftLines(model, lines1to2, 2));
    expect(shape(shifted)).toEqual([
      {
        notes: [
          [0, 2],
          [4, 2],
        ],
        end: 8,
      },
      {
        notes: [
          [42, 2],
          [46, 2],
        ],
        end: 50,
      },
      {
        notes: [
          [82, 2],
          [86, 2],
        ],
        end: 88,
      },
      {
        notes: [
          [120, 2],
          [124, 2],
        ],
        end: null,
      },
    ]);
  });

  it("produces only whole-Beat operations on the Notes and Line ends it moves", () => {
    const model = openTimingModel(song(4));
    const shifted = commitAt(model, shiftLines(model, lines1to2, -3));
    expect(operationsOf(shifted)).toEqual([
      { op: "setNoteStart", line: 13, start: 37 },
      { op: "setNoteStart", line: 14, start: 41 },
      { op: "setNoteStart", line: 16, start: 77 },
      { op: "setNoteStart", line: 17, start: 81 },
      { op: "setLineEnd", line: 15, beat: 45 },
    ]);
  });

  it("rounds a fractional shift to whole Beats and makes no edit for 0", () => {
    const model = openTimingModel(song(4));
    const shifted = commitAt(model, shiftLines(model, lines1to2, 1.6));
    expect(shape(shifted)?.[1]?.notes[0]).toEqual([42, 2]);
    expect(shiftLines(model, lines1to2, 0.4)).toBeNull();
  });

  it("reads as the Lines and the Beats in the edit list", () => {
    const model = openTimingModel(song(4));
    const describe = (beats: number, selection = lines1to2) =>
      describeEdit(must(shiftLines(model, selection, beats)).description);
    expect(describe(2)).toBe("Lines 2–3: +2 beats");
    expect(describe(-1, selectLine({ voice: 0, line: 0 }))).toBe(
      "Line 1: −1 beat",
    );
  });
});

describe("nudging a Line selection with , and .", () => {
  const beatsAfter = (direction: -1 | 1, shift: boolean) => {
    const model = openTimingModel(song(4));
    const nudged = commitAt(
      model,
      nudgeLines(model, lines1to2, { direction, shift }),
    );
    return must(shape(nudged)?.[1]?.notes[0])[0];
  };

  it("shifts it by -/+1 Beat, with Shift by -/+4", () => {
    expect(beatsAfter(-1, false)).toBe(39);
    expect(beatsAfter(1, false)).toBe(41);
    expect(beatsAfter(-1, true)).toBe(36);
    expect(beatsAfter(1, true)).toBe(44);
  });

  it("merges repeated nudges of the same selection within 1.5 s into one undo step", () => {
    let model = openTimingModel(song(4));
    const nudge = (direction: -1 | 1, now: number) => {
      model = commitAt(
        model,
        nudgeLines(model, lines1to2, { direction, shift: false }),
        now,
      );
    };
    nudge(1, 0);
    nudge(1, 1000);
    nudge(1, 2400);
    expect(model.applied).toHaveLength(1);
    expect(describeEdit(must(model.applied[0]).description)).toBe(
      "Lines 2–3: +3 beats",
    );
    expect(must(shape(model)?.[1]?.notes[0])[0]).toBe(43);
    nudge(1, 4000);
    expect(model.applied).toHaveLength(2);
  });

  it("never merges nudges of another selection", () => {
    let model = openTimingModel(song(4));
    model = commitAt(
      model,
      nudgeLines(model, lines1to2, { direction: 1, shift: false }),
      0,
    );
    const line1 = selectLine({ voice: 0, line: 1 });
    model = commitAt(
      model,
      nudgeLines(model, line1, { direction: 1, shift: false }),
      100,
    );
    expect(model.applied).toHaveLength(2);
  });

  it("leaves the same timing merged as stacked, Line breaks clamped on the way included", () => {
    // Line 2 (0-based) starts at Beat 80; the break after Line 1 is at 48.
    // Nudging Line 1 by +4 seven times pushes its last Note's end past 48,
    // which clamps that break; nudging back must replay the same way.
    const line1 = selectLine({ voice: 0, line: 1 });
    const steps: (-1 | 1)[] = [1, 1, 1, -1, -1, 1, -1, -1, -1];
    let merged = openTimingModel(song(4));
    let stacked = openTimingModel(song(4));
    steps.forEach((direction, i) => {
      merged = commitAt(
        merged,
        nudgeLines(merged, line1, { direction, shift: true }),
        i * 100,
      );
      stacked = commitAt(
        stacked,
        nudgeLines(stacked, line1, { direction, shift: true }),
        i * 2000,
      );
    });
    expect(merged.applied).toHaveLength(1);
    expect(stacked.applied).toHaveLength(steps.length);
    expect(shape(merged)).toEqual(shape(stacked));
  });
});

describe("Line breaks stay between their Lines", () => {
  it("moves a break to the end of its Line's last Note when that Line moves past it", () => {
    // Line 1's last Note ends at 46; its break is at 48.
    const model = openTimingModel(song(4));
    const shifted = commitAt(
      model,
      shiftLines(model, selectLine({ voice: 0, line: 1 }), 5),
    );
    expect(shape(shifted)?.[1]).toEqual({
      notes: [
        [45, 2],
        [49, 2],
      ],
      end: 51,
    });
  });

  it("moves a break to the next Line's first Note when that Line moves before it", () => {
    const model = openTimingModel(song(4));
    const shifted = commitAt(
      model,
      shiftLines(model, selectLine({ voice: 0, line: 2 }), -33),
    );
    expect(shape(shifted)?.[1]?.end).toBe(47);
    expect(shape(shifted)?.[2]?.notes[0]).toEqual([47, 2]);
  });

  it("holds for every break after any Line or Note edit on a well-formed Song", () => {
    const model = openTimingModel(song(6));
    const edits = [
      ...[-50, -33, -7, -1, 1, 4, 33, 60].flatMap((beats) => [
        shiftLines(model, lines1to2, beats),
        moveNote(model, { voice: 0, line: 2, note: 0 }, beats),
        moveNote(model, { voice: 0, line: 1, note: 1 }, beats),
      ]),
      ...[0.3, 0.5, 0.97, 1.5, 3].map((f) => stretchLines(model, lines1to2, f)),
      ...[1, 7, 40].map((length) =>
        setNoteLength(model, { voice: 0, line: 1, note: 1 }, length),
      ),
    ];
    for (const e of edits) {
      const lines = must(shape(commitAt(model, e)));
      lines.forEach((line, k) => {
        const next = lines[k + 1];
        if (line.end === null || !next) return;
        const [start, length] = must(line.notes.at(-1));
        const lo = must(start) + must(length);
        const hi = must(next.notes[0]?.[0]);
        expect(line.end).toBeLessThanOrEqual(hi);
        if (lo <= hi) expect(line.end).toBeGreaterThanOrEqual(lo);
      });
    }
  });
});

describe("stretching a Line selection", () => {
  it("maps every Note start and end to anchor + round((beat − anchor) × factor), anchored at the first Note", () => {
    // Anchor 40. Starts 40, 44, 80, 84 and ends 42, 46, 82, 86, ×1.5.
    const model = openTimingModel(song(4));
    const stretched = commitAt(model, stretchLines(model, lines1to2, 1.5));
    expect(shape(stretched)).toEqual([
      {
        notes: [
          [0, 2],
          [4, 2],
        ],
        end: 8,
      },
      // The break inside the range (48) maps to 52.
      {
        notes: [
          [40, 3],
          [46, 3],
        ],
        end: 52,
      },
      // The break after the range (88) is clamped to the new end, 109.
      {
        notes: [
          [100, 3],
          [106, 3],
        ],
        end: 109,
      },
      {
        notes: [
          [120, 2],
          [124, 2],
        ],
        end: null,
      },
    ]);
  });

  it("rounds the factor to 0.01 and keeps it at least 0.3", () => {
    const model = openTimingModel(song(4));
    expect(must(stretchLines(model, lines1to2, 1.234)).description).toEqual(
      expect.objectContaining({ factor: 1.23 }),
    );
    expect(must(stretchLines(model, lines1to2, 0.1)).description).toEqual(
      expect.objectContaining({ factor: 0.3 }),
    );
    expect(stretchLines(model, lines1to2, 1.004)).toBeNull();
  });

  it("keeps every length at least 1 Beat", () => {
    // ×0.3: 40→40, 42→41; 44→41, 46→42; 80→52, 82→53; 84→53, 86→54.
    const model = openTimingModel(song(4));
    const squeezed = commitAt(model, stretchLines(model, lines1to2, 0.1));
    expect(shape(squeezed)?.slice(1, 3)).toEqual([
      {
        notes: [
          [40, 1],
          [41, 1],
        ],
        end: 42,
      },
      {
        notes: [
          [52, 1],
          [53, 1],
        ],
        end: 88,
      },
    ]);
  });

  it("reads as the Lines and the factor in the edit list", () => {
    const model = openTimingModel(song(4));
    expect(
      describeEdit(must(stretchLines(model, lines1to2, 1.5)).description),
    ).toBe("Lines 2–3: stretched ×1.5");
  });
});

describe("one Note", () => {
  const second = { voice: 0, line: 1, note: 1 }; // Beat 44, 2 long, file line 14

  it("moves by whole Beats, pushing its Line's break along", () => {
    const model = openTimingModel(song(4));
    const moved = commitAt(model, moveNote(model, second, 3.4));
    expect(operationsOf(moved)).toEqual([
      { op: "setNoteStart", line: 14, start: 47 },
      { op: "setLineEnd", line: 15, beat: 49 },
    ]);
    expect(moveNote(model, second, 0.3)).toBeNull();
  });

  it("takes any whole length of at least 1 Beat", () => {
    const model = openTimingModel(song(4));
    const lengthAfter = (length: number) =>
      must(shape(commitAt(model, setNoteLength(model, second, length)))?.[1])
        .notes[1];
    expect(lengthAfter(5)).toEqual([44, 5]);
    expect(lengthAfter(2.6)).toEqual([44, 3]);
    expect(lengthAfter(0)).toEqual([44, 1]);
    expect(lengthAfter(-4)).toEqual([44, 1]);
    expect(setNoteLength(model, second, 2)).toBeNull();
  });

  it("reads as the Note, its Line and the change in the edit list", () => {
    const model = openTimingModel(song(4));
    const text = (e: ReturnType<typeof moveNote>) =>
      describeEdit(must(e).description);
    expect(text(moveNote(model, second, 2))).toBe(
      "Note “la” in Line 2 moved +2 beats",
    );
    expect(text(moveNote(model, second, -1))).toBe(
      "Note “la” in Line 2 moved −1 beat",
    );
    expect(text(setNoteLength(model, second, 5))).toBe(
      "Note “la” in Line 2: length 2 → 5 beats",
    );
  });

  it("makes no edit for a Note or Line that is not there", () => {
    const model = openTimingModel(song(4));
    expect(moveNote(model, { voice: 0, line: 9, note: 0 }, 1)).toBeNull();
    expect(setNoteLength(model, { voice: 1, line: 0, note: 0 }, 3)).toBeNull();
    expect(
      shiftLines(model, { voice: 0, anchor: 3, first: 3, last: 4 }, 1),
    ).toBeNull();
  });
});

describe("Line and Note edits in the history", () => {
  it("produce only whole-Beat Note and Line end operations", () => {
    let model = openTimingModel(song(4));
    model = commitAt(model, stretchLines(model, lines1to2, 1.37));
    model = commitAt(model, shiftLines(model, lines1to2, -2.7));
    model = commitAt(model, moveNote(model, { voice: 0, line: 3, note: 0 }, 5));
    model = commitAt(
      model,
      setNoteLength(model, { voice: 0, line: 0, note: 1 }, 3.2),
    );
    const ops = operationsOf(model);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      switch (op.op) {
        case "setNoteStart":
          expect(Number.isInteger(op.start)).toBe(true);
          break;
        case "setNoteLength":
          expect(Number.isInteger(op.length)).toBe(true);
          expect(op.length).toBeGreaterThanOrEqual(1);
          break;
        case "setLineEnd":
          expect(Number.isInteger(op.beat)).toBe(true);
          break;
        case "setGap":
        case "setBpm":
        case "setVideoGap":
          throw new Error(`unexpected ${op.op}`);
      }
    }
  });

  it("undo then redo returns the same operations", () => {
    let model = openTimingModel(song(4));
    model = commitAt(model, shiftLines(model, lines1to2, 2), 0);
    model = commitAt(model, stretchLines(model, lines1to2, 1.2), 5000);
    model = commitAt(
      model,
      moveNote(model, { voice: 0, line: 0, note: 0 }, 1),
      9000,
    );
    const before = operationsOf(model);
    const undone = undo(undo(model));
    expect(shape(undone)?.[1]?.notes[0]).toEqual([42, 2]);
    expect(operationsOf(redo(redo(undone)))).toEqual(before);
  });
});
