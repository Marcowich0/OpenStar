import { describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { ParsedSong } from "../../generated/ParsedSong";
import { frame, singVoices, type DrawList, type SingState } from "./frame";
import { ParticlePool } from "./effects";
import { laneLayout } from "./laneLayout";
import { LineRatings } from "./lineRating";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import { SPARKLE_RATE } from "./effects";
import { createRenderLoop } from "./renderLoop";

const grid = { gapSeconds: 1, beatsPerMinute: 120 };
const notes: Note[] = [4, 8, 12, 16, 20].map((start) => ({
  kind: "normal",
  start,
  length: 2,
  pitch: start % 5,
  text: "la ",
  line: 1,
}));
const song = {
  headers: grid,
  voices: [{ lines: [{ notes, end: null }] }],
} as unknown as ParsedSong;
const state: SingState = {
  grid,
  voices: singVoices(song),
  lanes: [{ colour: "cherry", voice: 0 }],
};

function setup(
  options: {
    avOffset?: number;
    state?: () => SingState;
    frameTime?: () => number;
  } = {},
) {
  let now = 0;
  const painted: DrawList[] = [];
  const callbacks: FrameRequestCallback[] = [];
  const loop = createRenderLoop({
    clock: () => ({ songTime: () => now }),
    avOffset: () => options.avOffset ?? 0,
    state: options.state ?? (() => state),
    paint: (list) => painted.push(list),
    requestFrame: (cb) => callbacks.push(cb),
    cancelFrame: vi.fn(),
    ...(options.frameTime && { frameTime: options.frameTime }),
  });
  return {
    loop,
    painted,
    callbacks,
    /** Sets the Song time without drawing. */
    time: (t: number) => {
      now = t;
    },
    at: (t: number) => {
      now = t;
      loop.step();
    },
  };
}

describe("the render loop", () => {
  it("draws at songTime() minus the Stage's A/V offset", () => {
    const { at, painted } = setup({ avOffset: 0.12 });
    at(4);
    expect(painted).toEqual([frame(state, 4 - 0.12, laneLayout(1))]);
  });

  it("draws the same list after skipped frames as when the time is reached smoothly", () => {
    const smooth = setup();
    for (let t = 2; t < 6; t += 1 / 144) smooth.at(t);
    smooth.at(6);
    const jumpy = setup();
    jumpy.at(2);
    jumpy.at(6); // two seconds of frames dropped
    expect(jumpy.painted.at(-1)).toEqual(smooth.painted.at(-1));
    expect(jumpy.painted.at(-1)).toEqual(frame(state, 6, laneLayout(1)));
  });

  it("lays the lanes out from the current Player count", () => {
    let current = state;
    const { at, painted } = setup({ state: () => current });
    at(3);
    current = {
      ...state,
      lanes: [...state.lanes, { colour: "sky", voice: 0 }],
    };
    at(3);
    expect(painted[1]).toEqual(frame(current, 3, laneLayout(2)));
  });

  it("asks for each frame with the same callback, and stops on stop()", () => {
    const { loop, callbacks, painted } = setup();
    loop.start();
    callbacks[0]?.(16);
    callbacks[1]?.(32);
    expect(callbacks).toHaveLength(3);
    expect(new Set(callbacks).size).toBe(1);
    expect(painted).toHaveLength(2);
    loop.stop();
    callbacks[2]?.(48);
    expect(painted).toHaveLength(2);
  });
});

describe("the render loop's effects", () => {
  /** One still star at (100, 100) under gravity 1000, alive 2 s. */
  function withStar() {
    const effects = new ParticlePool(4, { gravity: 1000 });
    effects.spawn(100, 100, 0, 0, 0, 2, 10, "star", "cherry", 0);
    return { ...state, effects };
  }

  function particleY(list: DrawList | undefined): number | undefined {
    return list?.find((e) => e.type === "particle")?.y;
  }

  it("advances the particles by the real time between animation frames, before drawing", () => {
    const effects = withStar();
    const { loop, callbacks, painted } = setup({ state: () => effects });
    loop.start();
    callbacks[0]?.(1000); // the first frame only notes the time
    expect(particleY(painted[0])).toBe(100);
    callbacks[1]?.(1100); // 0.1 s later
    expect(particleY(painted[1])).toBeCloseTo(100 + 0.5 * 1000 * 0.01, 6);
    callbacks[2]?.(1107); // 7 ms later, as at 144 Hz
    expect(particleY(painted[2])).toBeCloseTo(100 + 0.5 * 1000 * 0.107 ** 2, 6);
  });

  it("does not count the time the loop was stopped", () => {
    const effects = withStar();
    const { loop, callbacks, painted } = setup({ state: () => effects });
    loop.start();
    callbacks[0]?.(1000);
    loop.stop();
    loop.start();
    callbacks[2]?.(9000);
    expect(particleY(painted[1])).toBe(100);
  });

  it("moves particles by its frame time when given one, so a frozen one freezes them", () => {
    const effects = withStar();
    const { loop, callbacks, painted } = setup({
      state: () => effects,
      frameTime: () => 0,
    });
    loop.start();
    callbacks[0]?.(1000);
    callbacks[1]?.(2000);
    expect(particleY(painted[1])).toBe(100);
  });

  it("moves no particle on a step() of its own", () => {
    const effects = withStar();
    const { at, painted } = setup({ state: () => effects });
    at(1);
    at(2);
    expect(particleY(painted[1])).toBe(100);
  });
});

describe("the render loop's Line ratings", () => {
  function scale(list: DrawList | undefined): number | undefined {
    const entry = list?.find((e) => e.type === "lineRating");
    return entry?.type === "lineRating" ? entry.scale : undefined;
  }

  it("advances the pops by the real time between animation frames, before drawing", () => {
    const ratings = new LineRatings();
    ratings.show(0, "sing.lineRating.good");
    const { loop, callbacks, painted } = setup({
      state: () => ({ ...state, ratings }),
    });
    loop.start();
    callbacks[0]?.(1000);
    expect(scale(painted[0])).toBeCloseTo(0.3);
    callbacks[1]?.(1260);
    expect(scale(painted[1])).toBeCloseTo(1.2, 1);
    callbacks[2]?.(1660);
    expect(scale(painted[2])).toBeCloseTo(1);
  });
});

describe("the render loop's golden sparkle", () => {
  /** A golden Note on Beats 4–7 (3 s to 5 s) at C4, sung on pitch from 3 s to 3.5 s. */
  function goldenSung(): SingState {
    const golden: Note[] = [
      { kind: "golden", start: 4, length: 4, pitch: 0, text: "la ", line: 1 },
    ];
    const readings = new PitchBuffer(200);
    for (let ms = 3000; ms <= 3500; ms += 10) {
      readings.push(
        { captureMs: ms, pitch: 60, clarity: 0.95, loudness: -20 },
        ms / 1000,
      );
    }
    return {
      grid,
      voices: singVoices({
        voices: [{ lines: [{ notes: golden, end: null }] }],
      }),
      lanes: [
        {
          colour: "teal",
          voice: 0,
          trace: {
            readings,
            micThresholdDbfs: -40,
            difficulty: "medium",
            lostAt: null,
          },
        },
      ],
      effects: new ParticlePool(256),
    };
  }

  it("throws sparkles from the head ball while it hits a golden Note, by the real frame delta", () => {
    const sung = goldenSung();
    const { loop, callbacks, time } = setup({ state: () => sung });
    time(3.5);
    loop.start();
    callbacks[0]?.(1000); // the first frame only notes the time
    expect(sung.effects?.live).toBe(0);
    callbacks[1]?.(1250);
    expect(sung.effects?.live).toBe(SPARKLE_RATE / 4);
  });

  it("throws none off the golden Note", () => {
    const sung = goldenSung();
    const { loop, callbacks, time } = setup({ state: () => sung });
    time(2.5); // before the Note: no head ball
    loop.start();
    callbacks[0]?.(1000);
    callbacks[1]?.(1250);
    expect(sung.effects?.live).toBe(0);
  });

  it("throws none on a step() of its own (no real time passes)", () => {
    const sung = goldenSung();
    const { at } = setup({ state: () => sung });
    at(3.5);
    at(3.5);
    expect(sung.effects?.live).toBe(0);
  });
});
