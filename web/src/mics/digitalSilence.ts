// The "sends no sound" rule (v1 spec #51, "Mic warnings"): a switched-on
// Local mic warns once it has delivered exact digital silence, every sample
// zero, for more than 2 s. Quiet is never a warning: only exact zeros are
// certain. Fed on the Stage from both paths: a Stage-browser Local mic's
// worklet posts when its blocks turn all-zero or not (`PitchWorkletZeros`),
// a Mic bridge flags each 10 Hz level (`LocalMicLevel.digitalSilence`).
// Pure: times are Stage time in ms.

/** Exact zeros for longer than this warn, in ms. */
export const DIGITAL_SILENCE_MS = 2000;

export interface DigitalSilenceWatch {
  /**
   * Local mic `localMicId` delivered exact zeros (`zero`) or any sound at
   * `at`. Repeated zeros continue one run; sound ends it.
   */
  observe: (localMicId: string, zero: boolean, at: number) => void;
  /** Drops what is known of a Local mic (closed, unplugged, reopened). */
  forget: (localMicId: string) => void;
  /** The Local mics silent for more than 2 s at `now`, in id order. */
  silent: (now: number) => string[];
}

export function createDigitalSilenceWatch(): DigitalSilenceWatch {
  /** When each Local mic's current run of zeros began. */
  const since = new Map<string, number>();
  return {
    observe(localMicId, zero, at) {
      if (!zero) since.delete(localMicId);
      else if (!since.has(localMicId)) since.set(localMicId, at);
    },
    forget(localMicId) {
      since.delete(localMicId);
    },
    silent(now) {
      return [...since]
        .filter(([, start]) => now - start > DIGITAL_SILENCE_MS)
        .map(([id]) => id)
        .sort();
    },
  };
}
