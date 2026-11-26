import { describe, expect, it, vi } from "vitest";

import type { Difficulty } from "../../generated/Difficulty";
import * as scorer from "../../scoring/scorer";
import { readingHits } from "../../scoring/scorer";
import { isPaletteKey, TOKEN_NAMES } from "../../theme/tokens";

import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import {
  frame,
  singVoices,
  type DrawEntry,
  type LaneTrace,
  type PitchLineEntry,
  type SingState,
  type TracePoint,
} from "./frame";
import { laneLayout } from "./laneLayout";
import { TRACE_HOLD_SECONDS } from "./pitchTrace";

// Beat b starts at Song time 1 + b / 2 (Beat 0 at 1 s, half a second a Beat).
const grid = { gapSeconds: 1, beatsPerMinute: 120 };
const oneLane = laneLayout(1);
const THRESHOLD = -40;

function note(
  kind: NoteKind,
  start: number,
  length: number,
  pitch: number,
): Note {
  return { kind, start, length, pitch, text: "la ", line: 1 };
}

/** Beats 4–7 (3 s to 5 s) Normal at C4; Beats 10–11 (6 s to 7 s) Normal at E4. */
const notes = [note("normal", 4, 4, 0), note("normal", 10, 2, 4)];

interface Reading {
  songTime: number;
  /** Fractional MIDI note number (C4 = 60), or `null`. */
  pitch: number | null;
  clarity?: number;
  loudness?: number;
}

function buffer(readings: readonly Reading[], capacity = 2000): PitchBuffer {
  const b = new PitchBuffer(capacity);
  for (const r of readings) push(b, r);
  return b;
}

function push(b: PitchBuffer, r: Reading) {
  b.push(
    {
      captureMs: r.songTime * 1000,
      pitch: r.pitch,
      clarity: r.clarity ?? 0.95,
      loudness: r.loudness ?? -20,
    },
    r.songTime,
  );
}

/** Voiced readings every 10 ms from `from` up to `to` (inclusive), at `pitch`. */
function sung(from: number, to: number, pitch: number): Reading[] {
  const out: Reading[] = [];
  for (let ms = Math.round(from * 1000); ms <= Math.round(to * 1000); ms += 10)
    out.push({ songTime: ms / 1000, pitch });
  return out;
}

function trace(
  readings: PitchBuffer,
  overrides: Partial<LaneTrace> = {},
): LaneTrace {
  return {
    readings,
    micThresholdDbfs: THRESHOLD,
    difficulty: "medium",
    lostAt: null,
    ...overrides,
  };
}

function state(laneTrace: LaneTrace, voiceNotes: Note[] = notes): SingState {
  return {
    grid,
    voices: singVoices({
      voices: [{ lines: [{ notes: voiceNotes, end: null }] }],
    }),
    lanes: [{ colour: "cherry", voice: 0, trace: laneTrace }],
  };
}

function lines(list: readonly DrawEntry[]): PitchLineEntry[] {
  return list.filter((e): e is PitchLineEntry => e.type === "pitchLine");
}

function points(list: readonly DrawEntry[]): TracePoint[] {
  return lines(list).flatMap((l) => l.points);
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("empty");
  return item;
}

describe("the pitch trace held to the playhead", () => {
  it("reaches the playhead flat at the newest reading's pitch, with the head ball there", () => {
    // Sung at C4 + 20 cents from 3.0 s to 3.5 s; the playhead is at 3.7 s.
    const list = frame(state(trace(buffer(sung(3, 3.5, 60.2)))), 3.7, oneLane);
    const pts = points(list);
    const real = pts.filter((p) => !p.guessed);
    expect(real).toHaveLength(51);
    expect(last(real).songTime).toBe(3.5);
    const end = last(pts);
    expect(end).toMatchObject({ songTime: 3.7, x: 600, guessed: true });
    expect(end.pitch).toBeCloseTo(0.2, 9);
    // Every guessed point holds the newest reading's pitch.
    for (const p of pts.filter((q) => q.guessed))
      expect(p.pitch).toBeCloseTo(0.2, 9);
    // x follows Song time: 44 px per Beat, 2 Beats a second.
    expect(real[0]?.x).toBeCloseTo(600 - 0.7 * 2 * 44, 9);

    const balls = list.filter((e) => e.type === "headBall");
    expect(balls).toEqual([
      expect.objectContaining({
        lane: 0,
        x: 600,
        y: end.y,
        colour: "cherry",
      }),
    ]);
  });

  it("puts a point at the same height as a pill of the same pitch", () => {
    const list = frame(state(trace(buffer(sung(3, 3.5, 60)))), 3.5, oneLane);
    const pill = list.find((e) => e.type === "pill" && e.note.start === 4);
    if (pill?.type !== "pill") throw new Error("no pill");
    expect(last(points(list)).y).toBeCloseTo(pill.y + pill.height / 2, 9);
  });
});

describe("readings replacing the guess", () => {
  it("draws a later reading in place of the guessed part it covers, in the next frame", () => {
    const readings = buffer(sung(3, 3.5, 60));
    const s = state(trace(readings));
    const before = points(frame(s, 3.6, oneLane));
    expect(before.filter((p) => p.songTime > 3.5).every((p) => p.guessed)).toBe(
      true,
    );
    // Delayed readings arrive: the Player went up a semitone at 3.51 s.
    for (const r of sung(3.51, 3.58, 61)) push(readings, r);
    const after = points(frame(s, 3.6, oneLane));
    const covered = after.filter((p) => p.songTime > 3.5 && p.songTime <= 3.58);
    expect(covered).toHaveLength(8);
    for (const p of covered) {
      expect(p.guessed).toBe(false);
      expect(p.pitch).toBeCloseTo(1, 9);
    }
    // Only the stretch after the newest reading is still guessed, at its pitch.
    const guessed = after.filter((p) => p.guessed);
    expect(guessed.every((p) => p.songTime > 3.58)).toBe(true);
    expect(last(guessed).pitch).toBeCloseTo(1, 9);
  });
});

describe("when the guess stops", () => {
  it.each([
    ["below the Mic threshold", { loudness: THRESHOLD - 1 }],
    ["under clarity 0.8", { clarity: 0.79 }],
    ["without a pitch", { pitch: null }],
  ])("guesses nothing after a reading %s, and shows no head ball", (_, r) => {
    const readings = buffer([
      ...sung(3, 3.5, 60),
      { songTime: 3.51, pitch: 60, ...r },
    ]);
    const list = frame(state(trace(readings)), 3.6, oneLane);
    const pts = points(list);
    expect(pts.some((p) => p.guessed)).toBe(false);
    expect(last(pts).songTime).toBe(3.5);
    expect(list.some((e) => e.type === "headBall")).toBe(false);
  });

  it("uses exactly the scorer's voiced rule: clarity 0.8 at the threshold still guesses", () => {
    const readings = buffer([
      ...sung(3, 3.5, 60),
      { songTime: 3.51, pitch: 60, clarity: 0.8, loudness: THRESHOLD },
    ]);
    const pts = points(frame(state(trace(readings)), 3.6, oneLane));
    expect(last(pts)).toMatchObject({ songTime: 3.6, guessed: true });
  });

  it("breaks the line at unvoiced readings and starts a new run after them", () => {
    const readings = buffer([
      ...sung(3, 3.2, 60),
      { songTime: 3.21, pitch: null },
      ...sung(3.22, 3.4, 60),
    ]);
    const runs = lines(frame(state(trace(readings)), 3.4, oneLane));
    expect(runs).toHaveLength(2);
    expect(last(runs[0]?.points ?? []).songTime).toBe(3.2);
    expect(runs[1]?.points[0]?.songTime).toBe(3.22);
  });

  it("stops the guess once the playhead is 600 ms past the newest reading", () => {
    const readings = buffer(sung(3, 3.5, 60));
    const s = state(trace(readings));
    const held = frame(s, 4.09, oneLane);
    expect(last(points(held))).toMatchObject({ songTime: 4.09, guessed: true });
    expect(held.some((e) => e.type === "headBall")).toBe(true);

    const ended = frame(s, 4.1, oneLane);
    expect(last(points(ended))).toMatchObject({
      songTime: 3.5,
      guessed: false,
    });
    expect(ended.some((e) => e.type === "headBall")).toBe(false);
  });

  it("keeps the 600 ms in one named constant", () => {
    expect(TRACE_HOLD_SECONDS).toBe(0.6);
  });
});

describe("readings ahead of the playhead", () => {
  it("does not draw a reading whose Song time is still ahead", () => {
    // Drawing runs behind the clock (A/V offset), so readings can be ahead.
    const readings = buffer(sung(3, 3.5, 60));
    const list = frame(state(trace(readings)), 3.3, oneLane);
    const pts = points(list);
    expect(pts.every((p) => p.songTime <= 3.3)).toBe(true);
    expect(last(pts)).toMatchObject({ songTime: 3.3, x: 600, guessed: false });
  });
});

describe("the octave fold", () => {
  it("folds a point to the octave nearest the Note under it", () => {
    // An octave and 30 cents above the C4 Note under it, and two octaves below.
    const up = points(
      frame(state(trace(buffer(sung(3, 3.2, 72.3)))), 3.2, oneLane),
    );
    for (const p of up) expect(p.pitch).toBeCloseTo(0.3, 9);
    const down = points(
      frame(state(trace(buffer(sung(3, 3.2, 35.9)))), 3.2, oneLane),
    );
    for (const p of down) expect(p.pitch).toBeCloseTo(-0.1, 9);
  });

  it("folds to the nearest Note in time where no Note is under the point", () => {
    // Beats 8–9 (5 s to 6 s) have no Note: Beat 8 is nearest the C4 Note
    // (ends at Beat 7), Beat 9 nearest the E4 Note (starts at Beat 10).
    // A4 (9) folds to −3 against C4 (0) and stays 9 against E4 (4).
    const pts = points(
      frame(state(trace(buffer(sung(5, 5.9, 69)))), 5.9, oneLane),
    );
    const beat8 = pts.filter((p) => p.songTime < 5.5);
    const beat9 = pts.filter((p) => p.songTime >= 5.5);
    expect(beat8.length).toBeGreaterThan(0);
    expect(beat9.length).toBeGreaterThan(0);
    for (const p of beat8) expect(p.pitch).toBeCloseTo(-3, 9);
    for (const p of beat9) expect(p.pitch).toBeCloseTo(9, 9);
    // Before the first Note and after the last, the first and last Notes.
    const early = points(
      frame(state(trace(buffer(sung(1, 1.2, 69)))), 1.2, oneLane),
    );
    for (const p of early) expect(p.pitch).toBeCloseTo(-3, 9);
    const late = points(
      frame(state(trace(buffer(sung(9, 9.2, 69)))), 9.2, oneLane),
    );
    for (const p of late) expect(p.pitch).toBeCloseTo(9, 9);
  });
});

describe("hit colouring", () => {
  // Beats 4–7 Normal at C4, Beats 8–9 Rap, Beats 10–11 nothing, Beats 12–13 Freestyle.
  const mixed = [
    note("normal", 4, 4, 0),
    note("rap", 8, 2, 0),
    note("freestyle", 12, 2, 0),
  ];
  // A sweep across the tolerances, octaves off, and voiced readings only.
  const sweep: Reading[] = [];
  for (let i = 0; i < 400; i++) {
    const cents = ((i * 37) % 700) - 350;
    const octave = 12 * ((i % 3) - 1);
    sweep.push({ songTime: 3 + i / 100, pitch: 60 + octave + cents / 100 });
  }

  it.each(["easy", "medium", "hard"] as Difficulty[])(
    "agrees with the scorer's readingHits on every reading at %s",
    (difficulty) => {
      const readings = buffer(sweep);
      const s = state(trace(readings, { difficulty }), mixed);
      // Drawn from several playheads, so every reading is on screen once.
      const seen = new Map<number, boolean>();
      for (const t of [5, 7]) {
        for (const p of points(frame(s, t, oneLane))) {
          if (!p.guessed) seen.set(p.songTime, p.hit);
        }
      }
      let hits = 0;
      for (const r of sweep) {
        const beat = Math.floor((r.songTime - 1) * 2 + 1e-9);
        const under = mixed.find(
          (n) => beat >= n.start && beat < n.start + n.length,
        );
        const expected = under
          ? readingHits(
              { pitch: r.pitch, clarity: 0.95, loudness: -20 },
              THRESHOLD,
              under,
              difficulty,
            )
          : false;
        expect(seen.get(r.songTime), String(r.songTime)).toBe(expected);
        if (expected) hits += 1;
      }
      // The sweep has both hits and misses at every Difficulty.
      expect(hits).toBeGreaterThan(0);
      expect(hits).toBeLessThan(sweep.length);
    },
  );

  it("calls the scorer's exported test, never its own", () => {
    const spy = vi.spyOn(scorer, "readingHits");
    frame(state(trace(buffer(sung(3, 3.2, 60)))), 3.2, oneLane);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("tests guessed points at their held pitch, against the Note under each", () => {
    // Held 100 cents sharp of C4: a hit at Easy and Medium, a miss at Hard.
    for (const [difficulty, hit] of [
      ["easy", true],
      ["medium", true],
      ["hard", false],
    ] as const) {
      const pts = points(
        frame(
          state(trace(buffer(sung(3, 3.2, 61)), { difficulty })),
          3.7,
          oneLane,
        ),
      );
      const guessed = pts.filter((p) => p.guessed);
      expect(guessed.length).toBeGreaterThan(0);
      for (const p of guessed) expect(p.hit).toBe(hit);
    }
    // Held across into a Beat with no Note under it: those points miss.
    const across = points(
      frame(state(trace(buffer(sung(4.7, 4.8, 60)))), 5.2, oneLane),
    ).filter((p) => p.guessed);
    // Beat 7 ends at 5 s: the boundary gets a point for each side, so the
    // held stretch in Beat 7 hits and the one in Beat 8 misses.
    expect(across.map((p) => [p.songTime, p.hit])).toEqual([
      [5, true],
      [5, false],
      [5.2, false],
    ]);
  });

  it("styles hits in the Party colour over an ink edge and misses thin ink", () => {
    const [line] = lines(
      frame(state(trace(buffer(sung(3, 3.2, 60)))), 3.2, oneLane),
    );
    expect(line?.hit).toEqual({
      colour: "cherry",
      width: 12,
      edge: "--color-ink",
      edgeWidth: 17,
    });
    expect(line?.miss).toMatchObject({ colour: "--color-ink", alpha: 0.22 });
    expect(line?.miss.width).toBeCloseTo(6.6, 9);
    const narrow = lines(
      frame(
        state(trace(buffer(sung(3, 3.2, 60)))),
        3.2,
        laneLayout(4).slice(0, 1),
      ),
    )[0];
    expect(narrow?.hit.width).toBe(9);
    expect(narrow?.miss.width).toBeCloseTo(4.95, 9);
    const known = new Set<unknown>(TOKEN_NAMES);
    for (const c of [line?.hit.edge, line?.miss.colour])
      expect(known.has(c)).toBe(true);
    expect(isPaletteKey(line?.hit.colour)).toBe(true);
  });
});

describe("the head ball", () => {
  it("sits at the playhead at the current folded pitch while the Player is voiced", () => {
    const list = frame(state(trace(buffer(sung(3, 3.5, 72.5)))), 3.55, oneLane);
    const ball = list.find((e) => e.type === "headBall");
    expect(ball).toMatchObject({
      type: "headBall",
      x: 600,
      radius: 14,
      colour: "cherry",
      rim: "--color-white",
    });
    if (ball?.type !== "headBall") throw new Error("no ball");
    expect(ball.pitch).toBeCloseTo(0.5, 9);
    expect(ball.y).toBeCloseTo(last(points(list)).y, 9);
  });

  it("is absent with no readings, after an unvoiced reading, and on a lost lane", () => {
    const has = (s: SingState, t: number) =>
      frame(s, t, oneLane).some((e) => e.type === "headBall");
    expect(has(state(trace(buffer([]))), 3.5)).toBe(false);
    expect(
      has(
        state(
          trace(buffer([...sung(3, 3.4, 60), { songTime: 3.41, pitch: null }])),
        ),
        3.45,
      ),
    ).toBe(false);
    expect(
      has(state(trace(buffer(sung(3, 3.5, 60)), { lostAt: 3.5 })), 3.55),
    ).toBe(false);
  });

  it("bounces gently: wider and flatter by up to 14 %, keeping its area, moved by Song time", () => {
    const s = state(trace(buffer(sung(3, 3.5, 60))));
    const squash = (t: number) => {
      const ball = frame(s, t, oneLane).find((e) => e.type === "headBall");
      if (ball?.type !== "headBall") throw new Error("no ball");
      return ball.squash;
    };
    const seen = [3.3, 3.35, 3.4, 3.45, 3.5].map(squash);
    for (const { x, y } of seen) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(1.14);
      expect(x * y).toBeCloseTo(1, 9);
    }
    // It moves: not the same shape at every Song time.
    expect(new Set(seen.map(({ x }) => x.toFixed(4))).size).toBeGreaterThan(1);
    // The same Song time gives the same shape (a frozen frame stays still).
    expect(squash(3.4)).toEqual(squash(3.4));
    // Over a whole bounce it reaches close to 14 % and back to round.
    const xs = Array.from({ length: 200 }, (_, i) => squash(3 + i * 0.0025).x);
    expect(Math.max(...xs)).toBeGreaterThan(1.139);
    expect(Math.min(...xs)).toBeLessThan(1.001);
  });

  it("is marked golden only while it hits a golden Note", () => {
    const golden = [note("golden", 4, 4, 0), note("goldenRap", 10, 2, 4)];
    const ball = (s: SingState, t: number) => {
      const found = frame(s, t, oneLane).find((e) => e.type === "headBall");
      if (found?.type !== "headBall") throw new Error("no ball");
      return found.golden;
    };
    // On the golden Note's pitch: golden.
    expect(ball(state(trace(buffer(sung(3, 3.5, 60))), golden), 3.5)).toBe(
      true,
    );
    // Off its pitch: a miss, not golden.
    expect(ball(state(trace(buffer(sung(3, 3.5, 66))), golden), 3.5)).toBe(
      false,
    );
    // A golden Rap Note is hit by any voice.
    expect(ball(state(trace(buffer(sung(6, 6.5, 70))), golden), 6.5)).toBe(
      true,
    );
    // A Normal Note, hit: not golden.
    expect(ball(state(trace(buffer(sung(3, 3.5, 60)))), 3.5)).toBe(false);
    // Between Notes: not golden.
    expect(ball(state(trace(buffer(sung(5.1, 5.4, 60))), golden), 5.4)).toBe(
      false,
    );
  });

  it("is smaller in lanes under 130 px", () => {
    const list = frame(
      state(trace(buffer(sung(3, 3.5, 60)))),
      3.5,
      laneLayout(4).slice(0, 1),
    );
    expect(list.find((e) => e.type === "headBall")).toMatchObject({
      radius: 11,
    });
  });
});

describe("a lane whose Mic is lost", () => {
  const readings = () => buffer(sung(3, 3.5, 60));

  it("is marked lost, draws no pitch line after the loss, and keeps its Notes scrolling", () => {
    const s = state(trace(readings(), { lostAt: 3.4 }));
    const list = frame(s, 3.6, oneLane);
    expect(list.find((e) => e.type === "lane")).toMatchObject({
      lost: { colour: "--color-slate", alpha: 0.55, radius: 40 },
    });
    const pts = points(list);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.songTime < 3.4 && !p.guessed)).toBe(true);
    // The Notes still scroll with Song time.
    const pillX = (t: number) =>
      frame(s, t, oneLane).find(
        (e) => e.type === "pill" && e.note.start === 10,
      );
    expect(pillX(3.6)).toMatchObject({ x: 600 + (10 - 5.2) * 44 });
    expect(pillX(4.1)).toMatchObject({ x: 600 + (10 - 6.2) * 44 });
  });

  it("is not lost before the loss reaches the drawing time, or once the Mic is back", () => {
    const lane = (lostAt: number | null) =>
      frame(state(trace(readings(), { lostAt })), 3.6, oneLane).find(
        (e) => e.type === "lane",
      );
    expect(lane(3.7)).toMatchObject({ lost: null });
    expect(lane(null)).toMatchObject({ lost: null });
  });
});

describe("drawing never feeds scoring", () => {
  it("only reads the buffer and never runs the scorer's Beat judgement", () => {
    const readings = buffer(sung(3, 3.5, 60));
    const push = vi.spyOn(readings, "push");
    const clear = vi.spyOn(readings, "clear");
    const judge = vi.spyOn(scorer, "createScorer");
    const sizeBefore = readings.size;
    frame(state(trace(readings)), 3.7, oneLane);
    expect(push).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(readings.size).toBe(sizeBefore);
    // The guess is not in the buffer: its newest reading is still the real one.
    expect(readings.newestSongTime()).toBe(3.5);
    judge.mockRestore();
  });

  it("reads each buffer through one visitor that is the same every frame", () => {
    const readings = buffer(sung(3, 3.5, 60));
    const forEach = vi.spyOn(readings, "forEachFrom");
    const s = state(trace(readings));
    frame(s, 3.6, oneLane);
    frame(s, 3.7, oneLane);
    expect(forEach).toHaveBeenCalledTimes(2);
    expect(forEach.mock.calls[0]?.[1]).toBe(forEach.mock.calls[1]?.[1]);
  });
});
