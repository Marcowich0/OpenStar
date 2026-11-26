// Raw pitch accuracy of the detector against a hand-corrected f0 reference,
// octave-folded, as the Vocadito regression test measures it (ticket #91,
// `fixtures/vocadito/README.md`).

/** A 16-bit mono PCM WAV's samples, as floats in [−1, 1). */
export interface WavAudio {
  sampleRate: number;
  samples: Float32Array;
}

/** Reads a 16-bit mono PCM WAV; refuses any other kind. */
export function parseWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a RIFF WAV file");
  }
  let sampleRate: number | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(
          `only 16-bit mono PCM is read (format ${String(format)}, ${String(channels)} channels, ${String(bits)} bits)`,
        );
      }
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === "data") {
      if (sampleRate === null) throw new Error("WAV data before its fmt chunk");
      const samples = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(body + i * 2, true) / 32_768;
      }
      return { sampleRate, samples };
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  throw new Error("WAV file without a data chunk");
}

/** One frame of an f0 reference; `hz` 0 is unvoiced. */
export interface ReferenceFrame {
  timeS: number;
  hz: number;
}

/** Reads Vocadito's f0 CSV: one `time in seconds,f0 in Hz` row per frame. */
export function parseReferenceCsv(text: string): ReferenceFrame[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [timeS, hz] = line.split(",").map(Number);
      if (
        timeS === undefined ||
        hz === undefined ||
        !Number.isFinite(timeS) ||
        !Number.isFinite(hz)
      ) {
        throw new Error(`bad f0 row: ${line}`);
      }
      return { timeS, hz };
    });
}

/** A detector reading at its window centre: MIDI pitch, `null` unvoiced. */
export interface TimedPitch {
  timeS: number;
  pitch: number | null;
}

export interface Accuracy {
  /** Reference frames with an f0. */
  voicedFrames: number;
  /** Of those, frames whose nearest reading is within 50 cents, octave-folded. */
  hits: number;
}

const HIT_CENTS = 50;

/**
 * Octave-folded raw pitch accuracy: each voiced reference frame is judged by
 * the reading nearest in time (`readings` sorted by time). An unvoiced
 * reading is a miss.
 */
export function rawPitchAccuracy(
  reference: readonly ReferenceFrame[],
  readings: readonly TimedPitch[],
): Accuracy {
  let voicedFrames = 0;
  let hits = 0;
  let next = 0;
  for (const frame of reference) {
    if (frame.hz <= 0) continue;
    voicedFrames++;
    while (
      next + 1 < readings.length &&
      Math.abs((readings[next + 1]?.timeS ?? Infinity) - frame.timeS) <=
        Math.abs((readings[next]?.timeS ?? Infinity) - frame.timeS)
    ) {
      next++;
    }
    const pitch = readings[next]?.pitch ?? null;
    if (pitch === null) continue;
    const cents = (pitch - (69 + 12 * Math.log2(frame.hz / 440))) * 100;
    const folded = cents - 1200 * Math.round(cents / 1200);
    if (Math.abs(folded) <= HIT_CENTS) hits++;
  }
  return { voicedFrames, hits };
}
