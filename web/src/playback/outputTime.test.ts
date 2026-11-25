import { describe, expect, it } from "vitest";

import { outputTime, type OutputTimestampSource } from "./outputTime";

/** An `AudioContext` whose output timestamp and `currentTime` are set by hand. */
function context(
  ts: AudioTimestamp,
  currentTime = 99,
): OutputTimestampSource & { currentTime: number } {
  return { currentTime, getOutputTimestamp: () => ts };
}

describe("AudioContext time to the Stage's clock", () => {
  it("maps a context time through the reported output timestamp", () => {
    const audio = context({ contextTime: 10, performanceTime: 5000 });
    // 5000 + (10.25 − 10) × 1000
    expect(outputTime(audio, 10.25)).toBeCloseTo(5250, 9);
    expect(outputTime(audio, 9.5)).toBeCloseTo(4500, 9);
  });

  it("never uses the context's currentTime", () => {
    const ts = { contextTime: 2, performanceTime: 1000 };
    expect(outputTime(context(ts, 2), 3)).toBe(outputTime(context(ts, 7.5), 3));
  });

  it("reads a fresh timestamp on every call", () => {
    let ts: AudioTimestamp = { contextTime: 1, performanceTime: 100 };
    const audio = { getOutputTimestamp: () => ts };
    expect(outputTime(audio, 2)).toBe(1100);
    ts = { contextTime: 1.5, performanceTime: 640 };
    expect(outputTime(audio, 2)).toBe(1140);
  });

  it("has no answer before the context reports any output", () => {
    expect(outputTime(context({}), 1)).toBeNull();
    expect(
      outputTime(context({ contextTime: 0, performanceTime: 0 }), 1),
    ).toBeNull();
  });
});
