// The detector cases of `fixtures/detector/` for the WASM build: the signal
// generator and the limits `fixtures/detector/README.md` defines, a line-for-
// line port of the native run in `crates/detector/tests/fixtures.rs`. Both
// must follow the README exactly; `pitchProcessor.test.ts` checks that this
// one makes the same samples (by digest) as the native one.
//
// Test support only: nothing in the app imports this.

export type Waveform = "sine" | "sawtooth" | "noise" | "silence";

export interface Vibrato {
  rateHz: number;
  depthCents: number;
}

export interface Signal {
  midi?: number;
  levelDbfs?: number;
  seed?: number;
  onsetS?: number;
}

export interface Limits {
  medianCentsMax?: number;
  p99CentsMax?: number;
  clarityBelow?: number;
  loudnessToleranceDb?: number;
}

export interface CaseFile {
  description: string;
  sampleRates: number[];
  blockLen: number;
  waveform: Waveform;
  durationS: number;
  vibrato?: Vibrato;
  signals: Signal[];
  limits: Limits;
}

/** One reading as the worklet posts it (the fields the limits read). */
export interface CaseReading {
  pitch: number | null;
  clarity: number;
  loudness: number;
  endFrame: number;
}

export const WINDOW_LEN = 2048;
export const SILENCE_DBFS = -120;

const TAU = 2 * Math.PI;

export interface Generated {
  samples: Float32Array;
  onsetFrame: number;
}

/** Rust's `f64::round`: halves away from zero (`Math.round` rounds them up). */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function expectedOffsetCents(vibrato: Vibrato | undefined, u: number): number {
  return vibrato ? vibrato.depthCents * Math.sin(TAU * vibrato.rateHz * u) : 0;
}

/** One signal at one sample rate, as the README defines it. */
export function generate(
  file: CaseFile,
  signal: Signal,
  sampleRate: number,
): Generated {
  const len = roundHalfAway(file.durationS * sampleRate);
  const onsetFrame = roundHalfAway((signal.onsetS ?? 0) * sampleRate);
  const rms =
    signal.levelDbfs === undefined ? 0 : Math.pow(10, signal.levelDbfs / 20);
  const samples = new Float32Array(len);

  switch (file.waveform) {
    case "silence":
      break;
    case "noise": {
      if (signal.seed === undefined) throw new Error("noise needs a seed");
      let x = signal.seed >>> 0;
      const amplitude = Math.sqrt(3) * rms;
      for (let n = onsetFrame; n < len; n++) {
        x = (x ^ (x << 13)) >>> 0;
        x = (x ^ (x >>> 17)) >>> 0;
        x = (x ^ (x << 5)) >>> 0;
        const v = x / 4_294_967_296;
        samples[n] = amplitude * (2 * v - 1);
      }
      break;
    }
    case "sine":
    case "sawtooth": {
      if (signal.midi === undefined) throw new Error("tones need a midi note");
      const f0 = 440 * Math.pow(2, (signal.midi - 69) / 12);
      const depth = file.vibrato?.depthCents ?? 0;
      const harmonics = Math.floor(
        (0.45 * sampleRate) / (f0 * Math.pow(2, depth / 1200)),
      );
      let harmonicSum = 0;
      for (let k = 1; k <= harmonics; k++) harmonicSum += 1 / (k * k);
      const sawGain = rms / Math.sqrt(0.5 * harmonicSum);
      let phase = 0;
      for (let i = 0; onsetFrame + i < len; i++) {
        let value: number;
        if (file.waveform === "sine") {
          value = Math.SQRT2 * rms * Math.sin(phase);
        } else {
          let sum = 0;
          for (let k = 1; k <= harmonics; k++) sum += Math.sin(k * phase) / k;
          value = sawGain * sum;
        }
        samples[onsetFrame + i] = value;
        const u = i / sampleRate;
        const f = f0 * Math.pow(2, expectedOffsetCents(file.vibrato, u) / 1200);
        phase += (TAU * f) / sampleRate;
      }
      break;
    }
  }
  return { samples, onsetFrame };
}

/** FNV-1a (32-bit) over each sample's little-endian `f32` bytes, as the native run. */
export function samplesDigest(samples: Float32Array): number {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error("no values");
  return value;
}

/** Pitch errors in cents of every reading whose window lies wholly after the onset. */
export function pitchErrors(
  file: CaseFile,
  signal: Signal,
  generated: Generated,
  readings: CaseReading[],
  sampleRate: number,
): number[] {
  const midi = signal.midi;
  if (midi === undefined) throw new Error("tones need a midi note");
  return readings
    .filter((r) => r.endFrame - WINDOW_LEN >= generated.onsetFrame)
    .map((r) => {
      const centre = r.endFrame - WINDOW_LEN / 2;
      const u = (centre - generated.onsetFrame) / sampleRate;
      const expected = midi + expectedOffsetCents(file.vibrato, u) / 100;
      return r.pitch === null ? Infinity : 100 * Math.abs(r.pitch - expected);
    });
}

/**
 * Every limit of `file` for one signal's readings: the clarity and loudness
 * failures, as messages (empty when it passes).
 */
export function readingFailures(
  file: CaseFile,
  signal: Signal,
  generated: Generated,
  readings: CaseReading[],
): string[] {
  const failures: string[] = [];
  const { clarityBelow, loudnessToleranceDb } = file.limits;
  if (readings.length === 0) failures.push("no readings");
  if (clarityBelow !== undefined) {
    const worst = Math.max(0, ...readings.map((r) => r.clarity));
    if (!(worst < clarityBelow))
      failures.push(
        `clarity ${String(worst)} not below ${String(clarityBelow)}`,
      );
  }
  for (const r of readings) {
    const start = r.endFrame - WINDOW_LEN;
    const afterOnset = Math.max(
      0,
      r.endFrame - Math.max(generated.onsetFrame, start),
    );
    const p = afterOnset / WINDOW_LEN;
    const expected =
      signal.levelDbfs !== undefined && p > 0
        ? signal.levelDbfs + 10 * Math.log10(p)
        : SILENCE_DBFS;
    if (file.waveform === "silence") {
      if (r.loudness !== SILENCE_DBFS)
        failures.push(
          `endFrame ${String(r.endFrame)}: loudness ${String(r.loudness)}`,
        );
    } else if (loudnessToleranceDb !== undefined && (p === 0 || p >= 0.25)) {
      if (Math.abs(r.loudness - expected) > loudnessToleranceDb)
        failures.push(
          `endFrame ${String(r.endFrame)}: loudness ${String(r.loudness)} expected ${String(expected)}`,
        );
    }
  }
  return failures;
}
