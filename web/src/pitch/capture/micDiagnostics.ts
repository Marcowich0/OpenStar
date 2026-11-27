// Phone mic diagnostics: what a Phone's mic hears and how long each step of
// the way to the Stage takes, measured live so a Phone that "only picks up
// half the time" or lags can be read off the Phone itself (and, mirrored, off
// the Stage). Pure: every time is passed in (ms on the page's own clock), so
// the counters are tested without a browser and allocate nothing per reading
// once made.
//
// - `createFrameStats`: on the Phone, every reading the worklet makes, sorted
//   by the scorer's own rules (`isVoiced`) into gated (under the Mic
//   threshold), unvoiced (loud enough, no clear pitch) and voiced; its level;
//   the wait between the audio and the main thread; readings sent; clock
//   round trips.
// - `createArrivalStats`: on the Stage, every reading that arrives from one
//   Mic: readings per second, how long each took from capture to the Stage,
//   the longest gap between two, and how many came later than the scoring
//   window allows.
// - `MIC_PROCESSING`: the mic's voice processing (echo cancellation, noise
//   suppression, auto gain), switchable from the diagnostics to compare.

import type { StageMicReport } from "../../generated/StageMicReport";
import { isVoiced } from "../../scoring/beatValues";
import { SCORING } from "../../scoring/constants";

/** How far back the live figures look. */
export const DIAGNOSTICS_WINDOW_MS = 2000;

/** Far more than two seconds of a Mic's ~94 readings a second. */
const CAPACITY = 512;

/** Values with the time they were taken, of the last `windowMs`. */
class Recent {
  private readonly at = new Float64Array(CAPACITY);
  private readonly values = new Float64Array(CAPACITY);
  private next = 0;
  private count = 0;
  private readonly scratch: number[] = [];

  constructor(private readonly windowMs = DIAGNOSTICS_WINDOW_MS) {}

  add(atMs: number, value: number) {
    this.at[this.next] = atMs;
    this.values[this.next] = value;
    this.next = (this.next + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  clear() {
    this.count = 0;
  }

  /** The values taken in (`nowMs` − window, `nowMs`], newest first. */
  within(nowMs: number): number[] {
    const out = this.scratch;
    out.length = 0;
    for (let i = 0; i < this.count; i++) {
      const slot = (this.next - 1 - i + CAPACITY) % CAPACITY;
      const at = this.at[slot] ?? 0;
      if (at <= nowMs - this.windowMs) break;
      if (at <= nowMs) out.push(this.values[slot] ?? 0);
    }
    return out;
  }

  /** The times of `within`, newest first (a fresh array). */
  timesWithin(nowMs: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const slot = (this.next - 1 - i + CAPACITY) % CAPACITY;
      const at = this.at[slot] ?? 0;
      if (at <= nowMs - this.windowMs) break;
      if (at <= nowMs) out.push(at);
    }
    return out;
  }
}

/** p50, p95 and the maximum of some values; nulls when there are none. */
export interface Spread {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** The nearest-rank percentile `p` (0–100); null when empty. Sorts `values`. */
function rank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[at - 1] ?? null;
}

function minOf(values: readonly number[]): number | null {
  let min: number | null = null;
  for (const v of values) if (min === null || v < min) min = v;
  return min;
}

export function spreadOf(values: number[]): Spread {
  const sorted = values.sort((a, b) => a - b);
  return {
    p50: rank(sorted, 50),
    p95: rank(sorted, 95),
    max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
  };
}

/** How a reading counts against a Mic threshold, by the scorer's rules. */
export type FrameKind = "gated" | "unvoiced" | "voiced";

export function frameKind(
  reading: { pitch: number | null; clarity: number; loudness: number },
  micThresholdDbfs: number,
): FrameKind {
  if (reading.loudness < micThresholdDbfs) return "gated";
  return isVoiced(reading, micThresholdDbfs) ? "voiced" : "unvoiced";
}

const KIND_CODE = { gated: 0, unvoiced: 1, voiced: 2 } as const;

/** Shares (0 to 1) of the readings of the window, by kind. */
export interface FrameShares {
  gated: number;
  unvoiced: number;
  voiced: number;
}

export interface FrameStatsSummary {
  /** Readings the worklet made in the last second. */
  madePerSecond: number;
  /** Readings that left for the Stage in the last second. */
  sentPerSecond: number;
  /** By kind, against `thresholdDbfs`; null before any reading. */
  shares: FrameShares | null;
  /** The Mic threshold the readings were sorted against, dBFS. */
  thresholdDbfs: number;
  /** The newest reading's loudness, dBFS; null before any. */
  levelDbfs: number | null;
  /** Loudness over the window, dBFS. */
  level: Spread;
  /** The newest reading's pitch (fractional MIDI note) and clarity. */
  pitch: number | null;
  clarity: number | null;
  /**
   * How much longer than the quickest reading of the last second each
   * waited from its last audio frame to the main thread (the audio
   * callback's buffer and the worklet's queue), ms.
   */
  workletWaitMs: Spread;
  /** Clock ping round trips of the last 10 s, ms. */
  roundTripMs: Spread;
  /** The quickest of them: the one clock sync trusts. */
  roundTripMinMs: number | null;
}

export interface FrameStats {
  /** A reading the worklet made, handled at `atMs`. */
  reading: (
    atMs: number,
    reading: { pitch: number | null; clarity: number; loudness: number },
    workletWaitMs: number | null,
  ) => void;
  /** A reading left for the Stage at `atMs`. */
  sent: (atMs: number) => void;
  /** A clock ping came back after `roundTripMs`. */
  pong: (atMs: number, roundTripMs: number) => void;
  /** The Mic threshold to sort by from now on (dBFS). */
  setThreshold: (dbfs: number) => void;
  summary: (nowMs: number) => FrameStatsSummary;
  /** Forgets everything (the mic opened again). */
  clear: () => void;
}

export function createFrameStats(
  thresholdDbfs: number,
  windowMs = DIAGNOSTICS_WINDOW_MS,
): FrameStats {
  let threshold = thresholdDbfs;
  const loudness = new Recent(windowMs);
  const kinds = new Recent(windowMs);
  const waits = new Recent(windowMs);
  const sends = new Recent(1000);
  const made = new Recent(1000);
  const trips = new Recent(10_000);
  let newest: {
    pitch: number | null;
    clarity: number;
    loudness: number;
  } | null = null;
  return {
    reading(atMs, reading, workletWaitMs) {
      newest = {
        pitch: reading.pitch,
        clarity: reading.clarity,
        loudness: reading.loudness,
      };
      made.add(atMs, 1);
      loudness.add(atMs, reading.loudness);
      kinds.add(atMs, KIND_CODE[frameKind(reading, threshold)]);
      if (workletWaitMs !== null) waits.add(atMs, workletWaitMs);
    },
    sent(atMs) {
      sends.add(atMs, 1);
    },
    pong(atMs, roundTripMs) {
      trips.add(atMs, roundTripMs);
    },
    setThreshold(dbfs) {
      threshold = dbfs;
    },
    summary(nowMs) {
      const counted = kinds.within(nowMs);
      let shares: FrameShares | null = null;
      if (counted.length > 0) {
        const tally = [0, 0, 0];
        for (const code of counted) tally[code] = (tally[code] ?? 0) + 1;
        const n = counted.length;
        shares = {
          gated: (tally[0] ?? 0) / n,
          unvoiced: (tally[1] ?? 0) / n,
          voiced: (tally[2] ?? 0) / n,
        };
      }
      return {
        madePerSecond: made.within(nowMs).length,
        sentPerSecond: sends.within(nowMs).length,
        shares,
        thresholdDbfs: threshold,
        levelDbfs: newest?.loudness ?? null,
        level: spreadOf([...loudness.within(nowMs)]),
        pitch: newest?.pitch ?? null,
        clarity: newest?.clarity ?? null,
        workletWaitMs: spreadOf([...waits.within(nowMs)]),
        roundTripMs: spreadOf([...trips.within(nowMs)]),
        roundTripMinMs: minOf(trips.within(nowMs)),
      };
    },
    clear() {
      newest = null;
      for (const r of [loudness, kinds, waits, sends, made, trips]) r.clear();
    },
  };
}

/** A Mic's readings as they reach the Stage. */
export interface ArrivalStats {
  /** A reading captured at `captureMs` arrived at `atMs` (both Stage clock). */
  arrived: (atMs: number, captureMs: number, loudness: number) => void;
  /** What the Stage sends a Phone that asks (`micReport`). */
  report: (
    nowMs: number,
    settings: { micDelayMs: number; micThresholdDbfs: number },
  ) => StageMicReport;
}

export function createArrivalStats(
  windowMs = DIAGNOSTICS_WINDOW_MS,
): ArrivalStats {
  const latency = new Recent(windowMs);
  const perSecond = new Recent(1000);
  let lastLoudness: number | null = null;
  return {
    arrived(atMs, captureMs, loudness) {
      latency.add(atMs, atMs - captureMs);
      perSecond.add(atMs, 1);
      lastLoudness = loudness;
    },
    report(nowMs, settings) {
      const latencies = [...latency.within(nowMs)];
      const late = latencies.filter((ms) => ms > SCORING.gracePeriodMs).length;
      const times = latency.timesWithin(nowMs);
      let gap: number | null = null;
      for (let i = 1; i < times.length; i++) {
        const g = (times[i - 1] ?? 0) - (times[i] ?? 0);
        if (gap === null || g > gap) gap = g;
      }
      const spread = spreadOf(latencies);
      return {
        receivedPerSecond: perSecond.within(nowMs).length,
        arrivalP50Ms: spread.p50,
        arrivalP95Ms: spread.p95,
        arrivalMaxMs: spread.max,
        largestGapMs: gap,
        lateShare: latencies.length === 0 ? null : late / latencies.length,
        loudnessDbfs: lastLoudness,
        micDelayMs: settings.micDelayMs,
        micThresholdDbfs: settings.micThresholdDbfs,
      };
    },
  };
}

/**
 * The mic's voice processing. `standard` is what a Phone opens with (v1 spec
 * #50: echo cancellation and noise suppression on, auto gain off; on Android
 * echo cancellation alone cut the input delay from about 330 ms to 100 ms,
 * #10). The others exist to compare on a real Phone from the diagnostics.
 */
export const MIC_PROCESSING = {
  standard: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  },
  echoOnly: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
  },
  all: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  none: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
} as const satisfies Record<
  string,
  Pick<
    MediaTrackConstraints,
    "echoCancellation" | "noiseSuppression" | "autoGainControl"
  >
>;

export type MicProcessing = keyof typeof MIC_PROCESSING;

export const MIC_PROCESSINGS = Object.keys(MIC_PROCESSING) as MicProcessing[];

export function isMicProcessing(value: unknown): value is MicProcessing {
  return MIC_PROCESSINGS.some((p) => p === value);
}

/** `getUserMedia`'s constraints for `processing`: one channel, no video. */
export function micConstraints(
  processing: MicProcessing = "standard",
): MediaStreamConstraints {
  return {
    audio: { ...MIC_PROCESSING[processing], channelCount: { ideal: 1 } },
    video: false,
  };
}
