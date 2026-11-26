import { describe, expect, it } from "vitest";

import { FrameMeter, frameStats } from "./frameStats";

/** Frame timestamps (ms) at `hz`, from `from` for `count` frames. */
function stream(hz: number, count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, i) => from + (i * 1000) / hz);
}

describe("frameStats", () => {
  it("reads a steady 144 Hz stream with one dropped frame", () => {
    // Two seconds at 144 Hz; frame 250 is dropped, so one frame lasts two
    // refresh intervals.
    const frames = stream(144, 288).filter((_, i) => i !== 250);
    const stats = frameStats(frames);
    if (!stats) throw new Error("no stats");
    const interval = 1000 / 144;
    expect(stats.currentMs).toBeCloseTo(interval, 6);
    expect(stats.worstMs).toBeCloseTo(2 * interval, 6);
    // The last second holds 143 intervals, one of them double.
    expect(stats.frames).toBe(143);
    expect(stats.meanMs).toBeCloseTo((144 * interval) / 143, 6);
    expect(stats.refreshHz).toBeCloseTo(144, 6);
    expect(stats.budgetMs).toBeCloseTo(interval, 6);
  });

  it("looks only at the last second", () => {
    // A slow stretch long ago, then a clean second at 60 Hz.
    const frames = [0, 100, 200, ...stream(60, 61, 1000)];
    const stats = frameStats(frames);
    if (!stats) throw new Error("no stats");
    expect(stats.worstMs).toBeCloseTo(1000 / 60, 6);
    expect(stats.meanMs).toBeCloseTo(1000 / 60, 6);
    expect(stats.frames).toBe(60);
  });

  it("has nothing to say before two frames", () => {
    expect(frameStats([])).toBeNull();
    expect(frameStats([5])).toBeNull();
  });
});

describe("FrameMeter", () => {
  it("measures the budget from the refresh rate, not from a slow second", () => {
    const meter = new FrameMeter();
    // A clean second at 120 Hz, then a heavy second at 40 Hz.
    for (const t of stream(120, 121)) meter.frame(t);
    for (const t of stream(40, 41, 1000 + 25)) meter.frame(t);
    const stats = meter.stats();
    expect(stats?.meanMs).toBeCloseTo(25, 6);
    expect(stats?.refreshHz).toBeCloseTo(120, 6);
    expect(stats?.budgetMs).toBeCloseTo(1000 / 120, 6);
  });

  it("forgets frames older than a second", () => {
    const meter = new FrameMeter();
    for (const t of stream(144, 144 * 10)) meter.frame(t);
    expect(meter.size).toBeLessThanOrEqual(146);
  });
});
