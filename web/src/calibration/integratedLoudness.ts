/**
 * EBU R128 integrated loudness (ITU-R BS.1770-4) of mono samples at 48 kHz:
 * the measurement the Library makes of every Song with ffmpeg's `ebur128`
 * (#145), in TypeScript so a test can measure the Calibration tone run the
 * same way. K-weighting, 400 ms blocks every 100 ms, the −70 LUFS absolute
 * gate and the −10 LU relative gate.
 */

const SUPPORTED_RATE = 48_000;

/** BS.1770-4's K-weighting at 48 kHz: a high shelf, then a high pass. */
const K_WEIGHTING = [
  {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [-1.69065929318241, 0.73248077421585],
  },
  { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
] as const;

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** LUFS of a mean square. */
function loudness(meanSquare: number): number {
  return -0.691 + 10 * Math.log10(meanSquare);
}

function kWeighted(samples: Float32Array): Float64Array {
  let signal = Float64Array.from(samples);
  for (const { b, a } of K_WEIGHTING) {
    const out = new Float64Array(signal.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < signal.length; i++) {
      const x = signal[i] as number;
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      out[i] = y;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
    signal = out;
  }
  return signal;
}

/** Integrated loudness, LUFS; −∞ when every block is gated out. */
export function integratedLoudness(
  samples: Float32Array,
  sampleRate: number,
): number {
  if (sampleRate !== SUPPORTED_RATE) {
    throw new Error(`only ${String(SUPPORTED_RATE)} Hz is supported`);
  }
  const weighted = kWeighted(samples);
  const blockLength = Math.round(BLOCK_SECONDS * sampleRate);
  const step = Math.round(STEP_SECONDS * sampleRate);
  const blocks: number[] = [];
  for (let start = 0; start + blockLength <= weighted.length; start += step) {
    let sum = 0;
    for (let i = start; i < start + blockLength; i++) {
      const s = weighted[i] as number;
      sum += s * s;
    }
    blocks.push(sum / blockLength);
  }
  const mean = (values: number[]) =>
    values.reduce((total, v) => total + v, 0) / values.length;

  const aboveAbsolute = blocks.filter((z) => loudness(z) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return -Infinity;
  const relativeGate = loudness(mean(aboveAbsolute)) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((z) => loudness(z) > relativeGate);
  return loudness(mean(gated));
}
