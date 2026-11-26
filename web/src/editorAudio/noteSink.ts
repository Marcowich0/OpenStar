/**
 * Plays the Timing editor's clicks and hums (#220) on its one `AudioContext`,
 * into the gain chain's `input` after the Song gain, so they take the Song's
 * output path and its OpenStar volume. The start and end times come from the
 * scheduler (`noteScheduler.ts`), already mapped to `AudioContext` time.
 */

import type { GainChain } from "../playback/gainChain";
import type { SoundSink } from "./noteScheduler";

/** The part of a gain chain the sink plays into. */
export type SinkAudio = Pick<GainChain, "input"> & {
  context: Pick<AudioContext, "createOscillator" | "createGain">;
};

/** A click: a short, high blip with a fast decay; the accent is louder and higher. */
const CLICK = { frequencyHz: 1500, seconds: 0.03, peak: 0.35 } as const;
const ACCENT = { frequencyHz: 2400, seconds: 0.04, peak: 0.7 } as const;
/** The hum: a soft sine with short ramps, so Notes do not crackle. */
const HUM = { peak: 0.12, rampSeconds: 0.01 } as const;

export function createNoteSink({ context, input }: SinkAudio): SoundSink {
  return {
    play(sound, start, end) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      let stopAt: number;
      if (sound.kind === "hum") {
        oscillator.type = "sine";
        oscillator.frequency.value = sound.hz;
        const ramp = Math.min(HUM.rampSeconds, (end - start) / 2);
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(HUM.peak, start + ramp);
        envelope.gain.setValueAtTime(HUM.peak, end - ramp);
        envelope.gain.linearRampToValueAtTime(0, end);
        stopAt = end;
      } else {
        const click = sound.kind === "accent" ? ACCENT : CLICK;
        oscillator.type = "square";
        oscillator.frequency.value = click.frequencyHz;
        envelope.gain.setValueAtTime(click.peak, start);
        envelope.gain.linearRampToValueAtTime(0, start + click.seconds);
        stopAt = start + click.seconds;
      }
      oscillator.connect(envelope).connect(input);
      const release = () => {
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.onended = release;
      oscillator.start(start);
      oscillator.stop(stopAt);
      return () => {
        oscillator.onended = null;
        // Stops at once, also a sound that has not started yet.
        oscillator.stop();
        release();
      };
    },
  };
}
