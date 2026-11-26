/**
 * The Check A/V sync click (v1 spec #53, ticket #163): a short click once a
 * second on a gain chain's `AudioContext`, into `chain.input` after the Song
 * gain, so it passes through the OpenStar volume and takes a Song's output
 * path. Each click's landing time is its reported output time on the page's
 * clock through the shared `getOutputTimestamp()` mapping (`outputTime`),
 * never `currentTime`, which is read only to schedule.
 *
 * It takes any chain: the Stage's (`stageAudio().chain()`) or, later, the
 * Timing editor's own (#57), for its own browser and output.
 */

import type { GainChain } from "../playback/gainChain";
import { outputTime } from "../playback/outputTime";

/** A repeating timer; returns its cancel. Tests drive it by hand. */
export interface ClickTimer {
  every(ms: number, callback: () => void): () => void;
}

const browserTimer: ClickTimer = {
  every(ms, callback) {
    const handle = window.setInterval(callback, ms);
    return () => {
      window.clearInterval(handle);
    };
  },
};

export interface ClickTrack {
  /** The scheduled clicks' landing times, Stage clock ms, ascending. */
  landings(): readonly number[];
  /** Stops every scheduled click at once. */
  stop(): void;
}

/** One click every this many seconds. */
const PERIOD_SECONDS = 1;
/** The first click is this far ahead of the context's time. */
const LEAD_SECONDS = 0.3;
/** Clicks are scheduled this far ahead. */
const LOOKAHEAD_SECONDS = 1.5;
/** How often the scheduler looks ahead, ms. */
const TICK_MS = 250;
/** The click: a short, high blip with a fast decay. */
const CLICK = { frequencyHz: 1500, seconds: 0.03, peak: 0.5 } as const;
/** Landings kept for the drawing: a few seconds' worth. */
const KEPT_LANDINGS = 8;

export function startClickTrack(
  chain: GainChain,
  { timer = browserTimer }: { timer?: ClickTimer } = {},
): ClickTrack {
  const { context, input } = chain;
  const landings: number[] = [];
  const clicks: { oscillator: OscillatorNode; envelope: GainNode }[] = [];
  let next: number | null = null;

  function schedule() {
    const now = context.currentTime;
    next ??= now + LEAD_SECONDS;
    // A context that fell behind (a hidden tab) skips the missed clicks.
    while (next < now) next += PERIOD_SECONDS;
    while (next < now + LOOKAHEAD_SECONDS) {
      const landing = outputTime(context, next);
      // No output reported yet: try again on the next tick.
      if (landing === null) return;
      const start = next;
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = CLICK.frequencyHz;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(CLICK.peak, start);
      envelope.gain.linearRampToValueAtTime(0, start + CLICK.seconds);
      oscillator.connect(envelope).connect(input);
      const click = { oscillator, envelope };
      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
        const at = clicks.indexOf(click);
        if (at >= 0) clicks.splice(at, 1);
      };
      oscillator.start(start);
      oscillator.stop(start + CLICK.seconds);
      clicks.push(click);
      landings.push(landing);
      if (landings.length > KEPT_LANDINGS) landings.shift();
      next += PERIOD_SECONDS;
    }
  }

  schedule();
  const cancel = timer.every(TICK_MS, schedule);

  return {
    landings: () => landings,
    stop() {
      cancel();
      const now = context.currentTime;
      for (const { oscillator, envelope } of clicks) {
        oscillator.onended = null;
        oscillator.stop(now);
        oscillator.disconnect();
        envelope.disconnect();
      }
      clicks.length = 0;
    },
  };
}
