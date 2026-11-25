/**
 * The Calibration tone run (v1 spec #52, ticket #156): the Stage plays its
 * tones on the context of the gain chain the Song plays through (the Stage's
 * one `AudioContext`), into `chain.input` after the Song gain, so they pass
 * through the OpenStar volume and reach the speakers with a Song's output
 * delay and as loud as a Song at the same volume. It resolves with what the
 * Calibration analysis needs: each tone's reported output time and the
 * OpenStar volume.
 */

import { dbToGain } from "../playback/gain";
import type { GainChain } from "../playback/gainChain";
import { outputTime } from "../playback/outputTime";
import { CALIBRATION } from "../mics/micSettings";

/** What the run hands the Calibration analysis (`analyseCalibration`). */
export interface ToneRun {
  /** Each tone's reported output time on the Stage's clock, ms, in order. */
  toneOutputTimesMs: number[];
  /** The OpenStar volume in effect at the first tone, 0 to 100. */
  volume: number;
}

/** How far ahead of the context's time the first tone is scheduled, s. */
const LEAD_SECONDS = 0.1;

/** Each tone fades in and out over this long, s, so it starts and ends without a click. */
const RAMP_SECONDS = 0.005;

/**
 * The run's EBU R128 integrated loudness at amplitude 1, LUFS: 8 tones of
 * 200 ms at 440 Hz, 600 ms apart, with the 5 ms ramps. The Library's
 * ffmpeg `ebur128` command read the run rendered at 48 kHz with amplitude
 * −18 dB as −25.83 LUFS (`integratedLoudness`: −25.82). Loudness scales dB for dB with amplitude, so this sets the
 * amplitude for any target.
 */
const RUN_LOUDNESS_AT_FULL_SCALE_LUFS = -7.83;

/** Each tone's peak amplitude: the run comes to the Song loudness target. */
export const TONE_AMPLITUDE = dbToGain(
  CALIBRATION.toneLoudnessLufs - RUN_LOUDNESS_AT_FULL_SCALE_LUFS,
);

/**
 * Plays the run on `chain`'s context into `chain.input`. Each tone's output
 * time is read through the shared `getOutputTimestamp()` mapping when the
 * tone has played (never from `currentTime` at scheduling). Rejects if the
 * context reports no output, or with `signal`'s reason when aborted, which
 * stops every tone at once.
 */
export function playToneRun(
  chain: GainChain,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ToneRun> {
  const { context, input } = chain;
  const volume = chain.volume;
  const durationSeconds = CALIBRATION.toneDurationMs / 1000;
  const spacingSeconds = CALIBRATION.toneOnsetSpacingMs / 1000;
  const firstStart = context.currentTime + LEAD_SECONDS;

  return new Promise<ToneRun>((resolve, reject) => {
    const toneOutputTimesMs: number[] = [];
    let remaining = CALIBRATION.toneCount;
    let settled = false;
    const tones: { oscillator: OscillatorNode; envelope: GainNode }[] = [];

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      for (const { oscillator, envelope } of tones) {
        oscillator.onended = null;
        oscillator.stop(context.currentTime);
        oscillator.disconnect();
        envelope.disconnect();
      }
      if (error === undefined) resolve({ toneOutputTimesMs, volume });
      else reject(error);
    }
    function onAbort() {
      const reason: unknown = signal?.reason;
      finish(
        reason instanceof Error
          ? reason
          : new DOMException("the tone run was stopped", "AbortError"),
      );
    }

    for (let i = 0; i < CALIBRATION.toneCount; i++) {
      const start = firstStart + i * spacingSeconds;
      const stop = start + durationSeconds;
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = CALIBRATION.toneFrequencyHz;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(
        TONE_AMPLITUDE,
        start + RAMP_SECONDS,
      );
      envelope.gain.setValueAtTime(TONE_AMPLITUDE, stop - RAMP_SECONDS);
      envelope.gain.linearRampToValueAtTime(0, stop);
      oscillator.connect(envelope).connect(input);
      oscillator.onended = () => {
        const played = outputTime(context, start);
        if (played === null) {
          finish(new Error("the Stage's audio reports no output"));
          return;
        }
        toneOutputTimesMs[i] = played;
        remaining -= 1;
        if (remaining === 0) finish();
      };
      oscillator.start(start);
      oscillator.stop(stop);
      tones.push({ oscillator, envelope });
    }

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
  });
}
