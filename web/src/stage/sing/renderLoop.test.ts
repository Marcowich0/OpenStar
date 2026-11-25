import { describe, expect, it, vi } from "vitest";

import type { Note } from "../../generated/Note";
import type { ParsedSong } from "../../generated/ParsedSong";
import { frame, singVoices, type DrawList, type SingState } from "./frame";
import { laneLayout } from "./laneLayout";
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

function setup(options: { avOffset?: number; state?: () => SingState } = {}) {
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
  });
  return {
    loop,
    painted,
    callbacks,
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
