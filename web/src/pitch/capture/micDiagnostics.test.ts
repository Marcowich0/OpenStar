import { describe, expect, it } from "vitest";

import {
  createArrivalStats,
  createFrameStats,
  frameKind,
  micConstraints,
  spreadOf,
} from "./micDiagnostics";

const sung = { pitch: 57, clarity: 0.95, loudness: -24 };
const breathy = { pitch: 57, clarity: 0.5, loudness: -24 };
const quiet = { pitch: 57, clarity: 0.95, loudness: -36 };

describe("sorting a reading against a Mic threshold, as the scorer does", () => {
  it("is gated under the threshold, voiced at clarity 0.8 and up, else unvoiced", () => {
    expect(frameKind(quiet, -30)).toBe("gated");
    expect(frameKind(sung, -30)).toBe("voiced");
    expect(frameKind(breathy, -30)).toBe("unvoiced");
    expect(frameKind({ ...sung, pitch: null }, -30)).toBe("unvoiced");
    // Exactly at the threshold passes it.
    expect(frameKind({ ...sung, loudness: -30 }, -30)).toBe("voiced");
  });
});

describe("the Phone's frame stats", () => {
  it("gives the shares of the last 2 s, the level, the newest pitch and the rates", () => {
    const stats = createFrameStats(-30);
    // Two seconds and a bit at ~100 a second: 1 in 4 quiet, 1 in 4 breathy.
    for (let k = 0; k < 220; k++) {
      const at = 10 * k;
      const reading = k % 4 === 0 ? quiet : k % 4 === 1 ? breathy : sung;
      stats.reading(at, reading, k % 2 === 0 ? 4 : 12);
      stats.sent(at);
    }
    const s = stats.summary(2190);
    expect(s.shares).toEqual({ gated: 0.25, unvoiced: 0.25, voiced: 0.5 });
    expect(s.madePerSecond).toBe(100);
    expect(s.sentPerSecond).toBe(100);
    expect(s.levelDbfs).toBe(-24);
    expect(s.level.max).toBe(-24);
    expect(s.workletWaitMs).toEqual({ p50: 4, p95: 12, max: 12 });
    expect(s.pitch).toBe(57);
    expect(s.thresholdDbfs).toBe(-30);
  });

  it("sorts again by a new threshold from then on", () => {
    const stats = createFrameStats(-30);
    stats.reading(0, quiet, null);
    stats.setThreshold(-40);
    stats.reading(10, quiet, null);
    expect(stats.summary(10).shares).toEqual({
      gated: 0.5,
      unvoiced: 0,
      voiced: 0.5,
    });
  });

  it("keeps the round trips of the last 10 s and their quickest", () => {
    const stats = createFrameStats(-30);
    stats.pong(0, 30);
    stats.pong(1000, 6);
    stats.pong(2000, 9);
    const s = stats.summary(2000);
    expect(s.roundTripMinMs).toBe(6);
    expect(s.roundTripMs.max).toBe(30);
    expect(stats.summary(10_500).roundTripMinMs).toBe(6);
    expect(stats.summary(30_000).roundTripMinMs).toBeNull();
  });

  it("has no shares before any reading", () => {
    expect(createFrameStats(-30).summary(0).shares).toBeNull();
  });
});

describe("the Stage's arrival stats", () => {
  it("reports readings per second, capture to arrival, the longest gap and the late share", () => {
    const stats = createArrivalStats();
    // Every 10 ms; every tenth held back by Wi-Fi to 350 ms.
    for (let k = 0; k < 100; k++) {
      const capture = 1000 + 10 * k;
      const latency = k % 10 === 9 ? 350 : 40;
      stats.arrived(capture + latency, capture, -25);
    }
    const report = stats.report(2340, {
      micDelayMs: 100,
      micThresholdDbfs: -30,
    });
    // Arrived in (1340, 2340]: from the 31st reading on, and the three held
    // back from before it.
    expect(report.receivedPerSecond).toBe(69);
    expect(report.arrivalP50Ms).toBe(40);
    expect(report.arrivalMaxMs).toBe(350);
    expect(report.lateShare).toBeCloseTo(0.1);
    expect(report.largestGapMs).toBeGreaterThan(0);
    expect(report.loudnessDbfs).toBe(-25);
    expect(report.micDelayMs).toBe(100);
    expect(report.micThresholdDbfs).toBe(-30);
  });

  it("reports nothing measured before any reading", () => {
    expect(
      createArrivalStats().report(0, {
        micDelayMs: 100,
        micThresholdDbfs: -30,
      }),
    ).toEqual({
      receivedPerSecond: 0,
      arrivalP50Ms: null,
      arrivalP95Ms: null,
      arrivalMaxMs: null,
      largestGapMs: null,
      lateShare: null,
      loudnessDbfs: null,
      micDelayMs: 100,
      micThresholdDbfs: -30,
    });
  });
});

describe("the voice processing switch", () => {
  it("opens with the spec's constraints unless another is chosen", () => {
    expect(micConstraints()).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
      video: false,
    });
    expect(micConstraints("none").audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe("spreadOf", () => {
  it("is the nearest-rank p50 and p95 and the maximum", () => {
    expect(spreadOf([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 5, max: 5 });
    expect(spreadOf([])).toEqual({ p50: null, p95: null, max: null });
  });
});
