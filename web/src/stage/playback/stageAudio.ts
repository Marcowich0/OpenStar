/**
 * The Stage's single `AudioContext` and its gain chain (#53). The Song,
 * Calibration tones (#52) and the Check A/V sync click (#163) all play
 * through it, so they share one output path and one output delay.
 *
 * The context is made on first use; a browser starts it suspended until a
 * user gesture, so a screen that plays calls `resume()` from one.
 */

import { createGainChain, type GainChain } from "../../playback/gainChain";
import { outputTime } from "../../playback/outputTime";

export interface StageAudio {
  /** The one `AudioContext`. */
  context(): AudioContext;
  /** Media element → Song gain → OpenStar volume → output, and its `input`. */
  chain(): GainChain;
  /**
   * How long after the context hands a sample on it reaches the output, ms
   * (`baseLatency + outputLatency`, as the browser reports them).
   */
  outputLatencyMs(): number;
  /** The Stage time (ms) a sound scheduled at `contextTime` reaches the output. */
  outputTime(contextTime: number): number | null;
  resume(): Promise<void>;
}

export function createStageAudio(
  makeContext: () => AudioContext = () =>
    new AudioContext({ latencyHint: "interactive" }),
): StageAudio {
  let made: { context: AudioContext; chain: GainChain } | null = null;
  function get() {
    if (made === null) {
      const context = makeContext();
      made = { context, chain: createGainChain(context) };
    }
    return made;
  }
  return {
    context: () => get().context,
    chain: () => get().chain,
    outputLatencyMs() {
      const { context } = get();
      return ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000;
    },
    outputTime: (contextTime) => outputTime(get().context, contextTime),
    resume: () => get().context.resume(),
  };
}

let stage: StageAudio | null = null;

/** The Stage's audio, one per page. */
export function stageAudio(): StageAudio {
  stage ??= createStageAudio();
  return stage;
}
