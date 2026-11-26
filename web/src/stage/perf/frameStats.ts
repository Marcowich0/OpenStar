/**
 * Frame-time statistics for the `?perf` overlay (#227): the current, mean
 * and worst frame time over the last second, against the display's frame
 * budget, read from animation frame timestamps.
 *
 * A frame's time is the interval between its timestamp and the previous one,
 * so a dropped frame shows as a frame of two refresh intervals. The display's
 * refresh rate is the median interval of a second; the budget is one refresh
 * interval.
 */

/** How far back the statistics look, ms. */
export const STATS_WINDOW_MS = 1000;

export interface FrameStats {
  /** The last frame's time, ms. */
  currentMs: number;
  /** The mean frame time over the last second, ms. */
  meanMs: number;
  /** The longest frame of the last second, ms. */
  worstMs: number;
  /** How many frames ended in the last second. */
  frames: number;
  /** The display's refresh rate, Hz. */
  refreshHz: number;
  /** One refresh interval: the time a frame may take, ms. */
  budgetMs: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The statistics of the frames that ended in the last second before the
 * newest of `timestamps` (ms, ascending); `null` before two frames. The
 * refresh rate here is this second's own median.
 */
export function frameStats(timestamps: readonly number[]): FrameStats | null {
  const last = timestamps.at(-1);
  if (last === undefined || timestamps.length < 2) return null;
  const from = last - STATS_WINDOW_MS;
  const intervals: number[] = [];
  let sum = 0;
  let worst = 0;
  for (let i = timestamps.length - 1; i > 0; i--) {
    const end = timestamps[i] ?? 0;
    if (end <= from) break;
    const interval = end - (timestamps[i - 1] ?? end);
    intervals.push(interval);
    sum += interval;
    worst = Math.max(worst, interval);
  }
  const budgetMs = median(intervals);
  return {
    currentMs: intervals[0] ?? 0,
    meanMs: sum / intervals.length,
    worstMs: worst,
    frames: intervals.length,
    refreshHz: 1000 / budgetMs,
    budgetMs,
  };
}

/**
 * Keeps the last second of frame timestamps and the display's refresh rate.
 * The rate is the fastest one-second median seen so far: a heavy second runs
 * slower than the display, never faster, so it cannot lower the budget.
 */
export class FrameMeter {
  private readonly times: number[] = [];
  private bestBudgetMs = Infinity;
  private measuredAt: number | null = null;

  /** How many timestamps it keeps. */
  get size(): number {
    return this.times.length;
  }

  /** Takes an animation frame's timestamp, ms. */
  frame(timestamp: number): void {
    const times = this.times;
    times.push(timestamp);
    // Keep the frame just before the window: it starts the window's first interval.
    while (times.length > 2 && (times[1] ?? 0) <= timestamp - STATS_WINDOW_MS) {
      times.shift();
    }
    this.measuredAt ??= timestamp;
    if (timestamp - this.measuredAt >= STATS_WINDOW_MS) {
      this.measuredAt = timestamp;
      this.measure();
    }
  }

  /** The statistics now, with the display's measured refresh rate. */
  stats(): FrameStats | null {
    const stats = this.measure();
    if (!stats) return null;
    const budgetMs = this.bestBudgetMs;
    return { ...stats, budgetMs, refreshHz: 1000 / budgetMs };
  }

  private measure(): FrameStats | null {
    const stats = frameStats(this.times);
    if (stats) this.bestBudgetMs = Math.min(this.bestBudgetMs, stats.budgetMs);
    return stats;
  }
}
