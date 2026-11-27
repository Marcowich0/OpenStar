import { describe, expect, it } from "vitest";

import { beatAt, beatStart } from "../clock/beats";
import { describeEdit } from "./describeEdit";
import {
  moveSong,
  nudgeSong,
  stretchAroundPin,
  tempoAroundPlayhead,
  typeBpm,
  typeGap,
  typeVideoGap,
} from "./songEdits";
import {
  backToTheFile,
  currentTiming,
  editList,
  noteTimes,
  openTimingModel,
  operationsOf,
  redo,
  undo,
  type TimingEdit,
  type TimingModel,
} from "./timingModel";
import { commitAt, must, song } from "./testSong";

describe("the model derives the current timing from the loaded Song", () => {
  it("reads #GAP in ms, #BPM as in the file and #VIDEOGAP in seconds", () => {
    const timing = currentTiming(
      openTimingModel(song(4, { videoGapSeconds: 0.5 })),
    );
    expect(timing.gapMs).toBe(3650);
    expect(timing.bpm).toBe(217.4);
    expect(timing.videoGapSeconds).toBe(0.5);
    expect(timing.grid).toEqual({
      gapSeconds: 3.65,
      beatsPerMinute: 869.6,
    });
  });

  it("places a Note at GAP/1000 + beat × 60 / (BPM × 4) seconds", () => {
    const timing = currentTiming(openTimingModel(song()));
    const second = timing.song.voices[0]?.lines[1]?.notes[0]; // Beat 40, 2 long
    const { start, end } = noteTimes(timing.grid, must(second));
    expect(start).toBeCloseTo(3.65 + (40 * 15) / 217.4, 9);
    expect(end).toBeCloseTo(3.65 + (42 * 15) / 217.4, 9);
  });
});

describe("moving the whole Song", () => {
  it("changes #GAP by the dragged time, rounded to whole milliseconds", () => {
    const model = openTimingModel(song());
    const later = commitAt(model, moveSong(model, 0.12345));
    expect(currentTiming(later).gapMs).toBe(3773);
    expect(operationsOf(later)).toEqual([{ op: "setGap", seconds: 3.773 }]);
    const earlier = commitAt(model, moveSong(model, -2.9004));
    expect(currentTiming(earlier).gapMs).toBe(750);
  });

  it("makes no edit for a drag shorter than half a millisecond", () => {
    expect(moveSong(openTimingModel(song()), 0.0004)).toBeNull();
  });

  it("nudges #GAP by -/+10 ms with , and . and by -/+100 ms with Shift", () => {
    const model = openTimingModel(song());
    const gapAfter = (direction: -1 | 1, shift: boolean) =>
      currentTiming(commitAt(model, nudgeSong(model, { direction, shift })))
        .gapMs;
    expect(gapAfter(-1, false)).toBe(3640);
    expect(gapAfter(1, false)).toBe(3660);
    expect(gapAfter(-1, true)).toBe(3550);
    expect(gapAfter(1, true)).toBe(3750);
  });

  it("leaves every Note on its Beat and #BPM as it was", () => {
    const model = openTimingModel(song());
    const moved = commitAt(model, moveSong(model, 1.5));
    const ops = operationsOf(moved);
    expect(ops.every((op) => op.op === "setGap")).toBe(true);
    expect(currentTiming(moved).song.voices).toEqual(model.song.voices);
    expect(currentTiming(moved).bpm).toBe(217.4);
  });
});

describe("typed values", () => {
  const model = openTimingModel(song(4, { videoGapSeconds: 0.5 }));

  it("rounds a typed #GAP to whole milliseconds", () => {
    const typed = commitAt(model, typeGap(model, 753.4));
    expect(currentTiming(typed).gapMs).toBe(753);
    expect(operationsOf(typed)).toEqual([{ op: "setGap", seconds: 0.753 }]);
  });

  it("rounds a typed #BPM to two decimals and sends the real beat rate", () => {
    const typed = commitAt(model, typeBpm(model, 216.2567));
    expect(currentTiming(typed).bpm).toBeCloseTo(216.26, 9);
    expect(operationsOf(typed)).toEqual([
      { op: "setBpm", beatsPerMinute: 216.26 * 4 },
    ]);
  });

  it("rounds a typed #VIDEOGAP to two decimals of a second", () => {
    const typed = commitAt(model, typeVideoGap(model, -0.256));
    expect(currentTiming(typed).videoGapSeconds).toBe(-0.26);
  });

  it("makes no edit for a value that is not a number or does not change", () => {
    expect(typeGap(model, Number.NaN)).toBeNull();
    expect(typeGap(model, 3650.2)).toBeNull();
    expect(typeBpm(model, 0)).toBeNull();
    expect(typeBpm(model, -5)).toBeNull();
    expect(typeBpm(model, 217.401)).toBeNull();
    expect(typeVideoGap(model, Number.POSITIVE_INFINITY)).toBeNull();
    expect(typeVideoGap(model, 0.501)).toBeNull();
  });
});

describe("pin and stretch", () => {
  const model = openTimingModel(song(8));
  const grid = currentTiming(model).grid;
  /** Line 1 is pinned: its first Note is at Beat 40. */
  const pin = { voice: 0, line: 1 };
  const t1 = beatStart(grid, 40);

  it("solves #GAP and #BPM so the grabbed Beat follows the pointer", () => {
    // Grab Beat 200 and drag it 1 s later.
    const grab = beatStart(grid, 200);
    const edit = stretchAroundPin(model, {
      pin,
      grabSeconds: grab,
      pointerSeconds: grab + 1,
    });
    const stretched = currentTiming(commitAt(model, edit));
    expect(stretched.bpm).toBe(199.34);
    expect(stretched.gapMs).toBe(3400);
    expect(beatStart(stretched.grid, 200)).toBeCloseTo(grab + 1, 2);
  });

  it("keeps the pinned Line's first Note at its time", () => {
    const pinnedNote = { start: 40, length: 2 };
    for (const [grabBeat, drag] of [
      [200, 1],
      [300, -2.5],
      [8, 0.4], // a grab before the pin, 32 Beats away
      [113.37, 0.123],
    ] as const) {
      const grab = beatStart(grid, grabBeat);
      const edit = stretchAroundPin(model, {
        pin,
        grabSeconds: grab,
        pointerSeconds: grab + drag,
      });
      const after = currentTiming(commitAt(model, edit));
      expect(after.bpm).not.toBe(217.4);
      expect(
        Math.abs(noteTimes(after.grid, pinnedNote).start - t1),
      ).toBeLessThanOrEqual(0.0005);
    }
  });

  it("ignores a result outside 20–2000 BPM", () => {
    const grab = beatStart(grid, 200);
    // The grabbed Beat dragged onto the pin: the tempo would be huge.
    expect(
      stretchAroundPin(model, {
        pin,
        grabSeconds: grab,
        pointerSeconds: t1 + 0.01,
      }),
    ).toBeNull();
    // Dragged before the pin: a negative tempo.
    expect(
      stretchAroundPin(model, {
        pin,
        grabSeconds: grab,
        pointerSeconds: t1 - 1,
      }),
    ).toBeNull();
    // Dragged far away: below 20 BPM.
    expect(
      stretchAroundPin(model, {
        pin,
        grabSeconds: grab,
        pointerSeconds: grab + 200,
      }),
    ).toBeNull();
  });

  it("moves the whole Song when the grab is closer than 32 Beats to the pin", () => {
    const grab = beatStart(grid, 71.9);
    const edit = stretchAroundPin(model, {
      pin,
      grabSeconds: grab,
      pointerSeconds: grab + 0.25,
    });
    expect(edit?.description.kind).toBe("moveSong");
    const moved = currentTiming(commitAt(model, edit));
    expect(moved.gapMs).toBe(3900);
    expect(moved.bpm).toBe(217.4);
  });
});

describe("tempo around the playhead", () => {
  const model = openTimingModel(song(8));
  const { grid } = currentTiming(model);
  /** Song time at fractional Beat `b`. */
  const at = (b: number) => beatStart(grid, b);

  it("changes #BPM by -/+0.05 with [ and ] and by -/+0.5 with Shift", () => {
    const bpmAfter = (direction: -1 | 1, shift: boolean) =>
      currentTiming(
        commitAt(
          model,
          tempoAroundPlayhead(model, {
            direction,
            shift,
            playheadSeconds: at(100),
          }),
        ),
      ).bpm;
    expect(bpmAfter(-1, false)).toBe(217.35);
    expect(bpmAfter(1, false)).toBe(217.45);
    expect(bpmAfter(-1, true)).toBe(216.9);
    expect(bpmAfter(1, true)).toBe(217.9);
  });

  it("keeps the Beat under the playhead at the playhead", () => {
    for (const beat of [0.5, 100.25, 250.7]) {
      const playhead = at(beat);
      for (const shift of [false, true]) {
        const edit = tempoAroundPlayhead(model, {
          direction: 1,
          shift,
          playheadSeconds: playhead,
        });
        const after = currentTiming(commitAt(model, edit));
        expect(beatAt(after.grid, playhead)).toBe(Math.floor(beat));
        expect(
          Math.abs(beatStart(after.grid, beat) - playhead),
        ).toBeLessThanOrEqual(0.0005);
      }
    }
  });

  it("is ignored outside 20–2000 BPM", () => {
    const slow = openTimingModel(song(4, { beatsPerMinute: 20 * 4 }));
    expect(
      tempoAroundPlayhead(slow, {
        direction: -1,
        shift: false,
        playheadSeconds: 5,
      }),
    ).toBeNull();
  });
});

describe("only #GAP and #BPM change continuously", () => {
  it("no whole-Song gesture moves a Note or doubles #BPM", () => {
    const model = openTimingModel(song(8));
    const { grid } = currentTiming(model);
    const grab = beatStart(grid, 280);
    const edits = [
      moveSong(model, 0.37),
      nudgeSong(model, { direction: 1, shift: true }),
      stretchAroundPin(model, {
        pin: { voice: 0, line: 0 },
        grabSeconds: grab,
        pointerSeconds: grab + 1,
      }),
      tempoAroundPlayhead(model, {
        direction: 1,
        shift: true,
        playheadSeconds: 9,
      }),
    ];
    for (const edit of edits) {
      const after = currentTiming(commitAt(model, edit));
      expect(after.song.voices).toEqual(model.song.voices);
      expect(
        must(edit).operations.every(
          (op) => op.op === "setGap" || op.op === "setBpm",
        ),
      ).toBe(true);
      const ratio = after.bpm / 217.4;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });
});

describe("undo and redo", () => {
  /** A model with four edits of different gestures, one second apart. */
  function edited() {
    let model = openTimingModel(song(8, { videoGapSeconds: 0 }));
    const steps = [
      (m: TimingModel) => moveSong(m, 0.4),
      (m: TimingModel) => typeBpm(m, 210),
      (m: TimingModel) =>
        tempoAroundPlayhead(m, {
          direction: 1,
          shift: false,
          playheadSeconds: 8,
        }),
      (m: TimingModel) => typeVideoGap(m, 0.3),
      (m: TimingModel) => typeGap(m, 1000),
      (m: TimingModel) =>
        stretchAroundPin(m, {
          pin: { voice: 0, line: 0 },
          grabSeconds: 20,
          pointerSeconds: 20.5,
        }),
      (m: TimingModel) => nudgeSong(m, { direction: -1, shift: false }),
    ];
    steps.forEach((step, i) => {
      model = commitAt(model, step(model), i * 2000);
    });
    return model;
  }

  it("undo then redo returns the same operations", () => {
    const model = edited();
    expect(operationsOf(redo(undo(model)))).toEqual(operationsOf(model));
    expect(currentTiming(redo(undo(model)))).toEqual(currentTiming(model));
    const all = model.applied.reduce((m) => undo(m), model);
    const back = all.undone.reduce((m) => redo(m), all);
    expect(operationsOf(back)).toEqual(operationsOf(model));
  });

  it("covers every edit: undoing them all gives the file's timing back", () => {
    const model = edited();
    expect(model.applied).toHaveLength(7);
    const all = model.applied.reduce((m) => undo(m), model);
    expect(operationsOf(all)).toEqual([]);
    expect(currentTiming(all).song).toEqual(model.song);
  });

  it("undo with nothing to undo and redo with nothing to redo change nothing", () => {
    const model = openTimingModel(song());
    expect(undo(model)).toBe(model);
    expect(redo(model)).toBe(model);
  });

  it("a new edit after an undo clears the undone edits", () => {
    const undone = undo(undo(edited()));
    expect(undone.undone).toHaveLength(2);
    const next = commitAt(undone, moveSong(undone, 1), 100_000);
    expect(next.undone).toEqual([]);
    expect(redo(next)).toBe(next);
  });
});

describe("repeated nudges merge into one undo step", () => {
  const model = openTimingModel(song(8));
  const nudge = (m: TimingModel, now: number, direction: -1 | 1 = 1) =>
    commitAt(m, nudgeSong(m, { direction, shift: false }), now);

  it("merges nudges of the same kind within 1.5 s of each other", () => {
    let m = nudge(model, 0);
    m = nudge(m, 1000);
    m = nudge(m, 2500); // 1.5 s after the last one
    m = nudge(m, 3000, -1);
    expect(m.applied).toHaveLength(1);
    expect(currentTiming(m).gapMs).toBe(3670);
    expect(m.applied[0]?.description).toEqual({
      kind: "nudgeSong",
      fromGapMs: 3650,
      toGapMs: 3670,
    });
    expect(currentTiming(undo(m)).gapMs).toBe(3650);
  });

  it("starts a new step after more than 1.5 s", () => {
    let m = nudge(model, 0);
    m = nudge(m, 1501);
    expect(m.applied).toHaveLength(2);
    expect(currentTiming(undo(m)).gapMs).toBe(3660);
  });

  it("merges tempo nudges, but never a nudge of another kind", () => {
    const tempo = (m: TimingModel, now: number) =>
      commitAt(
        m,
        tempoAroundPlayhead(m, {
          direction: 1,
          shift: false,
          playheadSeconds: 9,
        }),
        now,
      );
    let m = tempo(model, 0);
    m = tempo(m, 500);
    expect(m.applied).toHaveLength(1);
    expect(m.applied[0]?.description).toMatchObject({
      fromBpm: 217.4,
      toBpm: 217.5,
    });
    m = nudge(m, 1000);
    m = tempo(m, 1200);
    expect(m.applied).toHaveLength(3);
  });

  it("never merges a drag or a typed value", () => {
    let m = commitAt(model, moveSong(model, 0.01), 0);
    m = nudge(m, 100);
    m = commitAt(m, moveSong(m, 0.01), 200);
    m = commitAt(m, moveSong(m, 0.01), 300);
    expect(m.applied).toHaveLength(4);
  });

  it("does not merge into an edit that follows an undo", () => {
    let m = nudge(model, 0);
    m = nudge(undo(nudge(m, 2000)), 2500);
    expect(m.applied).toHaveLength(2);
  });
});

describe("Back to the file", () => {
  it("drops every unsaved edit, the undone ones too", () => {
    let model = openTimingModel(song());
    model = commitAt(model, moveSong(model, 1), 0);
    model = commitAt(model, typeBpm(model, 100), 5000);
    model = undo(model);
    const back = backToTheFile(model);
    expect(back.applied).toEqual([]);
    expect(back.undone).toEqual([]);
    expect(back.song).toBe(model.song);
    expect(currentTiming(back).gapMs).toBe(3650);
  });
});

describe("the edit list", () => {
  const model = openTimingModel(song(8));
  const texts = (m: TimingModel) =>
    editList(m).map((e) => [describeEdit(e.description), e.undone]);

  it("describes each edit in words, with the values before and after", () => {
    const withVideoGap = openTimingModel(song(8, { videoGapSeconds: 0.5 }));
    const grab = beatStart(currentTiming(model).grid, 200);
    const cases: [TimingModel, TimingEdit | null, string][] = [
      [
        model,
        moveSong(model, 0.12345),
        "Whole Song moved: GAP 3,650 → 3,773 ms",
      ],
      [
        model,
        nudgeSong(model, { direction: -1, shift: true }),
        "Whole Song nudged: GAP 3,650 → 3,550 ms",
      ],
      [model, typeGap(model, 753), "GAP typed: 3,650 → 753 ms"],
      [model, typeBpm(model, 216.26), "BPM typed: 217.4 → 216.26"],
      [
        withVideoGap,
        typeVideoGap(withVideoGap, -0.25),
        "Video gap typed: 0.5 → -0.25 s",
      ],
      [model, typeVideoGap(model, 0.25), "Video gap typed: 0.25 s"],
      [
        model,
        stretchAroundPin(model, {
          pin: { voice: 0, line: 1 },
          grabSeconds: grab,
          pointerSeconds: grab + 1,
        }),
        "Stretched around the pinned Line: BPM 217.4 → 199.34, GAP 3,650 → 3,400 ms",
      ],
      [
        model,
        tempoAroundPlayhead(model, {
          direction: -1,
          shift: false,
          playheadSeconds: 3.65,
        }),
        "Tempo around the playhead: BPM 217.4 → 217.35, GAP 3,650 → 3,650 ms",
      ],
    ];
    for (const [m, edit, text] of cases) {
      expect(texts(commitAt(m, edit))).toEqual([[text, false]]);
    }
  });

  it("reports undone edits as undone, in the order they would be redone, until a new edit", () => {
    let m = commitAt(model, typeGap(model, 1000), 0);
    m = commitAt(m, typeGap(m, 2000), 5000);
    m = commitAt(m, typeGap(m, 3000), 10_000);
    m = undo(undo(m));
    expect(texts(m)).toEqual([
      ["GAP typed: 3,650 → 1,000 ms", false],
      ["GAP typed: 1,000 → 2,000 ms", true],
      ["GAP typed: 2,000 → 3,000 ms", true],
    ]);
    m = commitAt(m, nudgeSong(m, { direction: 1, shift: false }), 20_000);
    expect(texts(m)).toEqual([
      ["GAP typed: 3,650 → 1,000 ms", false],
      ["Whole Song nudged: GAP 1,000 → 1,010 ms", false],
    ]);
  });

  it("is empty with no edits", () => {
    expect(editList(model)).toEqual([]);
  });
});
