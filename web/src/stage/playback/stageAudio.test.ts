import { describe, expect, it } from "vitest";

import {
  asAudioContext,
  fakeAudioContext,
  pathFrom,
  type FakeNode,
} from "../../playback/fakeAudioContext";
import { createStageAudio, stageAudio } from "./stageAudio";

describe("the Stage's audio", () => {
  it("plays every sound through one AudioContext and its gain chain", () => {
    const context = fakeAudioContext();
    const made: unknown[] = [];
    const audio = createStageAudio(() => {
      made.push(context);
      return asAudioContext(context);
    });
    expect(made).toHaveLength(0); // nothing until something plays
    expect(audio.context()).toBe(context);
    expect(audio.chain()).toBe(audio.chain());
    expect(made).toHaveLength(1);
    const input = audio.chain().input as unknown as FakeNode;
    expect(pathFrom(input).at(-1)).toBe(context.destination);
  });

  it("is one per page", () => {
    expect(stageAudio()).toBe(stageAudio());
  });

  it("reports the output latency the browser knows about, in ms", () => {
    const context = fakeAudioContext();
    context.baseLatency = 0.005;
    context.outputLatency = 0.04;
    const audio = createStageAudio(() => asAudioContext(context));
    expect(audio.outputLatencyMs()).toBeCloseTo(45, 9);
  });

  it("maps its context's time to the Stage's clock", () => {
    const context = fakeAudioContext();
    context.timestamp = { contextTime: 4, performanceTime: 9000 };
    const audio = createStageAudio(() => asAudioContext(context));
    expect(audio.outputTime(4.5)).toBe(9500);
  });

  it("resumes its context (after a user gesture)", async () => {
    const context = fakeAudioContext();
    const audio = createStageAudio(() => asAudioContext(context));
    await audio.resume();
    expect(context.state).toBe("running");
  });
});
