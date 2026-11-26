// Tests only: a stand-in for `stage/playback/stageAudio` over the recording
// fake AudioContext, for tests that open Check A/V sync on the Stage (jsdom
// has no AudioContext). Use it as
// `vi.mock("…/stage/playback/stageAudio", () => fakeStageAudioModule())`.

import {
  fakeToneContext,
  type FakeToneContext,
} from "../calibration/fakeToneContext";
import { asAudioContext } from "../playback/fakeAudioContext";
import { createGainChain } from "../playback/gainChain";
import type { StageAudio } from "../stage/playback/stageAudio";

let made: FakeToneContext | null = null;

/** The fake context of the mocked module (made on the module's first use). */
export function fakeStageContext(): FakeToneContext {
  if (!made) throw new Error("the fake Stage audio was not mocked in");
  return made;
}

export function fakeStageAudioModule(): {
  stageAudio: () => StageAudio;
  createStageAudio: () => StageAudio;
} {
  const context = fakeToneContext();
  context.state = "running";
  context.currentTime = 3;
  // The context has output up to 2.95 s, which reached the output at 10 000 ms.
  context.timestamp = { contextTime: 2.95, performanceTime: 10_000 };
  made = context;
  const chain = createGainChain(asAudioContext(context));
  const stage: StageAudio = {
    context: () => asAudioContext(context),
    chain: () => chain,
    outputLatencyMs: () => 0,
    outputTime: () => null,
    resume: () => Promise.resolve(),
  };
  return { stageAudio: () => stage, createStageAudio: () => stage };
}
