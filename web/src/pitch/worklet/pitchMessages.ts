// What the pitch-detection worklet (`pitchProcessor.ts`) and the main thread
// (`pitchWorklet.ts`) pass each other. Frontend-internal: this never goes on
// the wire (the relayed Pitch reading is `PitchReading` in crates/protocol,
// made from this by the frame mapping onto the page's clock).

/** The name the processor registers under. */
export const PITCH_PROCESSOR_NAME = "openstar-pitch";

/** `processorOptions` of a pitch node: the `detector-wasm` module's bytes. */
export interface PitchProcessorOptions {
  wasm: ArrayBuffer;
}

/** One Pitch reading, posted as soon as the worklet made it. */
export interface PitchWorkletReading {
  type: "reading";
  /** Fractional MIDI note; `null` when the detector found no frequency. */
  pitch: number | null;
  /** The detector's clarity, 0 to 1. */
  clarity: number;
  /** RMS of the 2048-frame window in dBFS; digital silence is −120. */
  loudness: number;
  /**
   * The audio frame just after the newest sample in the window, on the
   * context's frame clock (`currentFrame` plus the block). The window's
   * centre is `endFrame − 1024`.
   */
  endFrame: number;
  /** The context's sample rate, Hz. */
  sampleRate: number;
}

export type PitchWorkletMessage = PitchWorkletReading;
