import { describe, expect, it } from "vitest";

import { beatStart } from "../../clock/beats";
import { extendSelection, selectLine } from "../../timing/selection";
import { must, song } from "../../timing/testSong";
import {
  commit,
  currentTiming,
  openTimingModel,
  operationsOf,
} from "../../timing/timingModel";
import { dragTo } from "./dragGestures";

// The test Song: GAP 3650 ms, BPM 217.4, so one Beat is 15 / 217.4 s
// (0.069 s). Line k has Notes at Beats 40k and 40k + 4, two Beats long.
const BEAT = 15 / 217.4;

describe("dragging empty space", () => {
  it("moves the whole Song by the dragged time, in whole ms, and says so", () => {
    const model = openTimingModel(song(4));
    const { edit, hint } = dragTo(
      model,
      { kind: "song", grabSeconds: 5, pin: null },
      0.5504,
    );
    expect(must(edit).operations).toEqual([{ op: "setGap", seconds: 4.2 }]);
    expect(hint).toBe("Whole Song 0.55 s later · GAP 3,650 → 4,200 ms");
  });

  it("says earlier for a drag to the left", () => {
    const model = openTimingModel(song(4));
    const { hint } = dragTo(
      model,
      { kind: "song", grabSeconds: 5, pin: null },
      -1.2,
    );
    expect(hint).toBe("Whole Song 1.2 s earlier · GAP 3,650 → 2,450 ms");
  });

  it("with a pin, stretches around it when the grab is at least 32 Beats away", () => {
    const model = openTimingModel(song(4));
    const pin = { voice: 0, line: 0 };
    // Grab Beat 120 (Line 3's first Note) and drag it 0.5 s later.
    const grid = currentTiming(model).grid;
    const grabSeconds = beatStart(grid, 120);
    const { edit, hint } = dragTo(
      model,
      { kind: "song", grabSeconds, pin },
      0.5,
    );
    const after = currentTiming(commit(model, must(edit), 0));
    // The pinned Note keeps its time; the grabbed Beat follows the pointer.
    expect(beatStart(after.grid, 0)).toBeCloseTo(3.65, 3);
    expect(beatStart(after.grid, 120)).toBeCloseTo(grabSeconds + 0.5, 2);
    expect(hint).toBe(
      `Stretch around the pin · BPM 217.4 → ${String(after.bpm)} · GAP 3,650 → ${after.gapMs.toLocaleString("en")} ms`,
    );
  });

  it("with a pin, moves the whole Song when the grab is closer than 32 Beats", () => {
    const model = openTimingModel(song(4));
    const grabSeconds = beatStart(currentTiming(model).grid, 20);
    const { edit } = dragTo(
      model,
      { kind: "song", grabSeconds, pin: { voice: 0, line: 0 } },
      0.1,
    );
    expect(must(edit).operations).toEqual([{ op: "setGap", seconds: 3.75 }]);
  });

  it("works with no Pitch track: it needs only the model", () => {
    const model = openTimingModel(song(1));
    expect(
      dragTo(model, { kind: "song", grabSeconds: 4, pin: null }, 0).edit,
    ).toBeNull();
  });
});

describe("dragging a Line selection", () => {
  const lines1to2 = extendSelection(selectLine({ voice: 0, line: 1 }), {
    voice: 0,
    line: 2,
  });

  it("shifts it by the nearest whole Beats and shows Beats and seconds", () => {
    const model = openTimingModel(song(4));
    const { edit, hint } = dragTo(
      model,
      { kind: "lines", selection: lines1to2 },
      2.4 * BEAT,
    );
    expect(operationsOf(commit(model, must(edit), 0))).toContainEqual({
      op: "setNoteStart",
      line: 13,
      start: 42,
    });
    expect(hint).toBe("+2 beats (0.14 s) · whole beats only");
  });

  it("changes nothing under half a Beat", () => {
    const model = openTimingModel(song(4));
    const result = dragTo(
      model,
      { kind: "lines", selection: lines1to2 },
      0.4 * BEAT,
    );
    expect(result).toEqual({ edit: null, hint: null });
  });

  it("says earlier Beats with a minus", () => {
    const model = openTimingModel(song(4));
    const { hint } = dragTo(
      model,
      { kind: "lines", selection: selectLine({ voice: 0, line: 1 }) },
      -BEAT,
    );
    expect(hint).toBe("−1 beat (−0.07 s) · whole beats only");
  });

  it("stretches it by the ◀▶ handle: the factor is the dragged length over the length", () => {
    const model = openTimingModel(song(4));
    // Lines 1–2 span Beats 40–86: 46 Beats. Dragging 23 Beats more is ×1.5.
    const { edit, hint } = dragTo(
      model,
      { kind: "stretch", selection: lines1to2 },
      23 * BEAT,
    );
    expect(must(edit).description).toMatchObject({
      kind: "stretchLines",
      factor: 1.5,
    });
    expect(hint).toBe("Stretch ×1.5 · notes snap to whole beats");
  });
});

describe("Alt-dragging a Note", () => {
  const note = { voice: 0, line: 1, note: 0 };

  it("moves it by whole Beats", () => {
    const model = openTimingModel(song(4));
    const { edit, hint } = dragTo(model, { kind: "note", note }, 3 * BEAT);
    expect(must(edit).operations).toContainEqual({
      op: "setNoteStart",
      line: 13,
      start: 43,
    });
    expect(hint).toBe("Note +3 beats (0.21 s) · whole beats only");
  });

  it("changes its length by its right end, at least 1 Beat", () => {
    const model = openTimingModel(song(4));
    const longer = dragTo(model, { kind: "noteEnd", note }, 2 * BEAT);
    expect(must(longer.edit).operations).toEqual([
      { op: "setNoteLength", line: 13, length: 4 },
    ]);
    expect(longer.hint).toBe("Length 4 beats (0.28 s)");
    const shortest = dragTo(model, { kind: "noteEnd", note }, -10 * BEAT);
    expect(must(shortest.edit).operations).toEqual([
      { op: "setNoteLength", line: 13, length: 1 },
    ]);
    expect(shortest.hint).toBe("Length 1 beat (0.07 s)");
  });
});
