import { describe, expect, it } from "vitest";

import {
  createRateCounter,
  measureDetectorCost,
  percentile,
} from "./diagnostics";
import { detectorModule } from "./testCapture";

describe("the readings-per-second counter", () => {
  it("counts the readings of the last second", () => {
    const rate = createRateCounter();
    expect(rate.perSecond(0)).toBe(0);
    // One every 512 / 48 000 s ≈ 10.67 ms: about 94 a second.
    for (let k = 0; k < 300; k++) rate.add(1000 + (k * 512) / 48);
    const last = 1000 + (299 * 512) / 48;
    expect(rate.perSecond(last)).toBe(94);
    // Nothing came for a second and a bit.
    expect(rate.perSecond(last + 1001)).toBe(0);
  });
});

describe("percentile", () => {
  it("is the nearest rank", () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("the detector's cost per window", () => {
  it("times the WASM detector on this thread, one window at a time", async () => {
    // A fake clock that moves 0.25 ms per read: every window costs the
    // reads made while it runs, so the result is exactly predictable.
    let now = 0;
    const clock = () => (now += 0.25);
    const cost = await measureDetectorCost({
      module: await detectorModule(),
      sampleRate: 48000,
      windows: 40,
      now: clock,
      pause: () => Promise.resolve(),
    });
    // One read before and one after each window.
    expect(cost).toEqual({ windows: 40, p50Ms: 0.25, p95Ms: 0.25 });
  });

  it("measures a real cost on the real clock", async () => {
    const cost = await measureDetectorCost({
      module: await detectorModule(),
      sampleRate: 48000,
      windows: 20,
    });
    expect(cost.windows).toBe(20);
    expect(cost.p50Ms).toBeGreaterThan(0);
    expect(cost.p95Ms).toBeGreaterThanOrEqual(cost.p50Ms);
  });
});
