// What the Phone's diagnostics readout shows (ticket #128): readings per
// second leaving the Phone, and the pitch detector's cost per window at p50
// and p95, measured by timing the WASM detector on the main thread (the
// release checklist's detector-cost item reads it).

import { createWasmReadingMaker } from "../worklet/wasmReadingMaker";

/** Counts events over the last second. Allocation-free once made. */
export interface RateCounter {
  add: (atMs: number) => void;
  /** Events in (`nowMs` − 1 s, `nowMs`]. */
  perSecond: (nowMs: number) => number;
}

/** Far more than a Mic's ~94 readings a second. */
const RATE_CAPACITY = 1024;

export function createRateCounter(): RateCounter {
  const times = new Float64Array(RATE_CAPACITY);
  let newest = -1;
  let count = 0;
  return {
    add(atMs) {
      newest = (newest + 1) % RATE_CAPACITY;
      times[newest] = atMs;
      count = Math.min(count + 1, RATE_CAPACITY);
    },
    perSecond(nowMs) {
      let seen = 0;
      for (let i = 0; i < count; i++) {
        const at = times[(newest - i + RATE_CAPACITY) % RATE_CAPACITY] ?? 0;
        if (at <= nowMs - 1000) break;
        if (at <= nowMs) seen++;
      }
      return seen;
    },
  };
}

/** The nearest-rank percentile `p` (0–100) of `values`; null when empty. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export interface DetectorCost {
  windows: number;
  p50Ms: number;
  p95Ms: number;
}

export interface DetectorCostOptions {
  /** The `detector-wasm` module (the worklet's own file). */
  module: WebAssembly.Module;
  sampleRate: number;
  /** How many windows to time. */
  windows?: number;
  /** The clock, ms (`performance.now()`). */
  now?: () => number;
  /** Yields to the page between batches, so the timing never blocks it. */
  pause?: () => Promise<void>;
}

/** Windows timed between two pauses. */
const BATCH = 10;

/**
 * Feeds the detector a sung-like signal 128 frames at a time, as the
 * worklet does, and times each window: from the first block after the last
 * reading to the block that makes the next one.
 */
export async function measureDetectorCost({
  module,
  sampleRate,
  windows = 200,
  now = () => performance.now(),
  pause = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    }),
}: DetectorCostOptions): Promise<DetectorCost> {
  const maker = createWasmReadingMaker(module, sampleRate);
  // One second of signal, made before any timing so only the detector is
  // timed: a 220 Hz voice with an overtone and a little noise.
  const signal = new Float32Array(
    Math.ceil(sampleRate / maker.capacity) * maker.capacity,
  );
  for (let i = 0; i < signal.length; i++) {
    const t = i / sampleRate;
    signal[i] =
      0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.15 * Math.sin(2 * Math.PI * 440 * t) +
      0.02 * (Math.random() - 0.5);
  }
  let at = 0;
  const nextBlock = () => {
    const block = signal.subarray(at, at + maker.capacity);
    at = (at + maker.capacity) % signal.length;
    return block;
  };
  // The first window fills the detector and grows its memory: not counted.
  while (!maker.push(nextBlock()));
  const costs: number[] = [];
  while (costs.length < windows) {
    const start = now();
    while (!maker.push(nextBlock()));
    costs.push(now() - start);
    if (costs.length % BATCH === 0 && costs.length < windows) await pause();
  }
  return {
    windows: costs.length,
    p50Ms: percentile(costs, 50) ?? 0,
    p95Ms: percentile(costs, 95) ?? 0,
  };
}
