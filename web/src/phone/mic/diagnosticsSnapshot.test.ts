import { describe, expect, it } from "vitest";

import { createFrameStats } from "../../pitch/capture/micDiagnostics";
import { resolveMicSettings } from "../../mics/micSettings";
import { diagnosticsSnapshot } from "./diagnosticsSnapshot";
import type { PhoneMicDiagnostics } from "./phoneMic";
import { quietDiagnostics } from "./testPhoneMic";
import { withHandThreshold } from "./usePhoneMicSettings";

const UNCALIBRATED = resolveMicSettings({
  kind: "phone",
  stored: undefined,
  volume: 80,
});

function measured(): PhoneMicDiagnostics {
  const frames = createFrameStats(-30);
  for (let k = 0; k < 100; k++) {
    frames.reading(10 * k, { pitch: 57, clarity: 0.9, loudness: -26 }, 8);
    frames.sent(10 * k);
  }
  frames.pong(500, 12);
  return {
    ...quietDiagnostics(),
    state: "on",
    capture: {
      sampleRate: 48000,
      baseLatencyMs: 4,
      outputLatencyMs: 47,
      requested: {
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      },
      settings: { echoCancellation: true, sampleRate: 48000 },
      label: "Microphone",
      muted: false,
      readyState: "live",
    },
    frames: frames.summary(990),
    clockOffsetMs: 1234.56,
    detector: { windows: 200, p50Ms: 0.31, p95Ms: 0.72 },
    wakeLock: true,
    stage: {
      receivedPerSecond: 97,
      arrivalP50Ms: 64,
      arrivalP95Ms: 125,
      arrivalMaxMs: 246,
      largestGapMs: 101,
      lateShare: 0.004,
      loudnessDbfs: -26,
      micDelayMs: 100,
      micThresholdDbfs: -30,
    },
    stageReportAgeMs: 400,
  };
}

describe("the diagnostics snapshot", () => {
  it("splits the delay into its steps from what the Phone and the Stage measured", () => {
    const snapshot = diagnosticsSnapshot(measured(), UNCALIBRATED, "UA");
    expect(snapshot.latency).toEqual({
      halfWindowMs: 21.3,
      workletWaitP50Ms: 8,
      workletWaitP95Ms: 8,
      detectorP50Ms: 0.3,
      detectorP95Ms: 0.7,
      captureToStageP50Ms: 64,
      captureToStageP95Ms: 125,
      captureToStageMaxMs: 246,
      // 64 − 21.3 − 8.
      networkAndRelayP50Ms: 34.7,
      bestOneWayMs: 6,
      largestGapMs: 101,
      lateShare: 0.004,
      stageFrameMs: 16.7,
      micDelayMs: 100,
      gracePeriodMs: 300,
      scoredAfterBeatEndMs: 400,
    });
    expect(snapshot).toMatchObject({
      userAgent: "UA",
      audio: { sampleRate: 48000, baseLatencyMs: 4, outputLatencyMs: 47 },
      constraints: { echoCancellation: true, noiseSuppression: true },
      trackSettings: { echoCancellation: true, sampleRate: 48000 },
      track: { label: "Microphone", muted: false, readyState: "live" },
      threshold: {
        effectiveDbfs: -30,
        source: "default",
        calibrated: false,
        stageDbfs: -30,
      },
      frames: { gated: 0, unvoiced: 0, voiced: 1 },
      rates: { sentPerSecond: 100, stageReceivedPerSecond: 97 },
      clock: { offsetMs: 1234.6, bestRoundTripMs: 12 },
    });
  });

  it("leaves out a Stage report that is too old", () => {
    const snapshot = diagnosticsSnapshot(
      { ...measured(), stageReportAgeMs: 5000 },
      UNCALIBRATED,
      "UA",
    );
    expect(snapshot.rates.stageReceivedPerSecond).toBeNull();
    expect(snapshot.latency.captureToStageP50Ms).toBeNull();
    // The Phone's own Mic delay stands in.
    expect(snapshot.latency.micDelayMs).toBe(100);
  });

  it("is plain JSON", () => {
    const snapshot = diagnosticsSnapshot(measured(), UNCALIBRATED, "UA");
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("a Phone's hand setting kept at once", () => {
  it("replaces only this Phone's threshold, keeping its Calibration", () => {
    const values = {
      stageOutput: "Speakers",
      mics: [
        {
          mic: { kind: "phone" as const, phoneId: "me" },
          settings: { calibration: { micDelayMs: 90, bleedLevelDbfs: -42 } },
        },
        {
          mic: { kind: "phone" as const, phoneId: "other" },
          settings: {},
        },
      ],
    };
    expect(withHandThreshold(values, "me", -38).mics).toEqual([
      { mic: { kind: "phone", phoneId: "other" }, settings: {} },
      {
        mic: { kind: "phone", phoneId: "me" },
        settings: {
          calibration: { micDelayMs: 90, bleedLevelDbfs: -42 },
          micThreshold: { referenceDbfs: -38, setBy: "hand" },
        },
      },
    ]);
  });
});
