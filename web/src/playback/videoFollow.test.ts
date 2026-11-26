import { describe, expect, it } from "vitest";

import { followVideo, VIDEO_FOLLOW } from "./videoFollow";

describe("how a separate video follows the audio (#53)", () => {
  it("aims at the audio position plus #VIDEOGAP", () => {
    // In step: audio at 10 s, #VIDEOGAP 2.5 s, the video at 12.5 s.
    expect(
      followVideo({ audioSeconds: 10, videoSeconds: 12.5, gapSeconds: 2.5 }),
    ).toEqual({ kind: "rate", rate: 1 });
    // A negative #VIDEOGAP: the video runs behind the audio.
    expect(
      followVideo({ audioSeconds: 10, videoSeconds: 9, gapSeconds: -1 }),
    ).toEqual({ kind: "rate", rate: 1 });
  });

  it("slows a video that runs a little ahead with a small playbackRate change", () => {
    const step = followVideo({
      audioSeconds: 10,
      videoSeconds: 10.02,
      gapSeconds: 0,
    });
    expect(step.kind).toBe("rate");
    if (step.kind !== "rate") return;
    expect(step.rate).toBeCloseTo(0.98, 6);
  });

  it("speeds up a video that runs a little behind", () => {
    const step = followVideo({
      audioSeconds: 10,
      videoSeconds: 9.97,
      gapSeconds: 0,
    });
    expect(step.kind).toBe("rate");
    if (step.kind !== "rate") return;
    expect(step.rate).toBeCloseTo(1.03, 6);
  });

  it("corrects drift of up to 50 ms by rate, never by more than ±5 %", () => {
    for (const drift of [0.05, -0.05, 0.049]) {
      const step = followVideo({
        audioSeconds: 20,
        videoSeconds: 20 + drift,
        gapSeconds: 0,
      });
      expect(step.kind).toBe("rate");
      if (step.kind !== "rate") continue;
      expect(Math.abs(step.rate - 1)).toBeLessThanOrEqual(
        VIDEO_FOLLOW.maxRateChange + 1e-9,
      );
      expect(Math.abs(step.rate - 1)).toBeGreaterThan(0);
    }
  });

  it("resyncs a video more than 50 ms ahead or behind with a seek to its target", () => {
    expect(
      followVideo({ audioSeconds: 10, videoSeconds: 11.06, gapSeconds: 1 }),
    ).toEqual({ kind: "seek", toSeconds: 11 });
    expect(
      followVideo({ audioSeconds: 10, videoSeconds: 10.9, gapSeconds: 1 }),
    ).toEqual({ kind: "seek", toSeconds: 11 });
    // After a Restart or a stall the video is far off: one seek.
    expect(
      followVideo({ audioSeconds: 0, videoSeconds: 42, gapSeconds: 0 }),
    ).toEqual({ kind: "seek", toSeconds: 0 });
  });

  it("waits at the video's start while its target is before position 0", () => {
    // #VIDEOGAP −5 s: the video starts 5 s into the audio.
    expect(
      followVideo({ audioSeconds: 3, videoSeconds: 0, gapSeconds: -5 }),
    ).toEqual({ kind: "before" });
    expect(
      followVideo({ audioSeconds: 5, videoSeconds: 0, gapSeconds: -5 }),
    ).toEqual({ kind: "rate", rate: 1 });
  });

  it("leaves a video alone once its target is past its end", () => {
    // The audio runs on after a shorter video: no seek every frame.
    expect(
      followVideo({
        audioSeconds: 31,
        videoSeconds: 30,
        gapSeconds: 0,
        videoDurationSeconds: 30,
      }),
    ).toEqual({ kind: "after" });
    expect(
      followVideo({
        audioSeconds: 29,
        videoSeconds: 29,
        gapSeconds: 0,
        videoDurationSeconds: 30,
      }),
    ).toEqual({ kind: "rate", rate: 1 });
    // An unknown duration (NaN before metadata) never counts as the end.
    expect(
      followVideo({
        audioSeconds: 5,
        videoSeconds: 5,
        gapSeconds: 0,
        videoDurationSeconds: Number.NaN,
      }),
    ).toEqual({ kind: "rate", rate: 1 });
  });
});
