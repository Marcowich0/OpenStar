// What the pitch-detection worklet (`pitchProcessor.ts`) and the main thread
// (`pitchWorklet.ts`) pass each other. Frontend-internal: this never goes on
// the wire (the relayed Pitch reading is `PitchReading` in crates/protocol,
// made from this by the frame mapping onto the page's clock).

/** The name the processor registers under. */
export const PITCH_PROCESSOR_NAME = "openstar-pitch";

/**
 * `processorOptions` of a pitch node: the `detector-wasm` module's bytes, and
 * whether its detector runs from the start (default: it does).
 */
export interface PitchProcessorOptions {
  wasm: ArrayBuffer;
  detect?: boolean;
}

/**
 * The main thread's command to a pitch node: run its detector or not. A node
 * whose detector is off still meters its input (`PitchWorkletLevel`); one
 * switched on starts a fresh detector, with an empty window.
 */
export interface PitchNodeCommand {
  type: "detect";
  on: boolean;
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
   * Whether the newest 2048 frames are exact digital silence, every sample
   * exactly 0 (not quiet noise): the "sends no sound" warning's input.
   */
  zero: boolean;
  /**
   * The audio frame just after the newest sample in the window, on the
   * context's frame clock (`currentFrame` plus the block). The window's
   * centre is `endFrame − 1024`.
   */
  endFrame: number;
  /** The context's sample rate, Hz. */
  sampleRate: number;
}

/**
 * What a node whose detector is off posts instead of a reading, on the same
 * schedule: the loudness of the same 2048-frame window, as the detector would
 * report it. A meter reads it; nothing scores it.
 */
export interface PitchWorkletLevel {
  type: "level";
  /** RMS of the 2048-frame window in dBFS; digital silence is −120. */
  loudness: number;
  /** As a reading's `zero`. */
  zero: boolean;
  /** As a reading's `endFrame`. */
  endFrame: number;
}

export type PitchWorkletMessage = PitchWorkletReading | PitchWorkletLevel;
