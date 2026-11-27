/**
 * How far the playing Song has got, as a Remote shows it (#159).
 *
 * The Stage reports its position and rate only on events (start, pause,
 * resume, Restart, Skip intro, end); the server passes the latest report on with its
 * age. Between reports a Remote extrapolates: the position advances at the
 * reported rate (1 playing, 0 paused or ended) and stops at the Song's
 * length. Nothing here reaches a Phone's mic, which is never told Song time.
 */

import type { RequestId } from "../generated/RequestId";
import type { SongProgress } from "../generated/SongProgress";

/** The latest report, pinned to this browser's clock. */
export interface ProgressAnchor {
  requestId: RequestId;
  positionSeconds: number;
  rate: number;
  lengthSeconds: number | null;
  /** Where Skip intro lands (`null`: no Intro to skip). */
  introEndSeconds: number | null;
  /** This browser's time (ms) at which the reported position held. */
  atMs: number;
}

/** The Song's progress at one moment. */
export interface ProgressValue {
  /** Song time, seconds: from 0 up to the length. */
  positionSeconds: number;
  lengthSeconds: number | null;
  /** `positionSeconds / lengthSeconds` (0 to 1); `null` without a length. */
  fraction: number | null;
}

/** Pins a report heard at `receivedAtMs` (this browser's clock) to that clock. */
export function anchorProgress(
  progress: SongProgress,
  receivedAtMs: number,
): ProgressAnchor {
  return {
    requestId: progress.requestId,
    positionSeconds: progress.positionSeconds,
    rate: progress.rate,
    lengthSeconds: progress.lengthSeconds,
    introEndSeconds: progress.introEndSeconds,
    atMs: receivedAtMs - progress.ageMs,
  };
}

/** The progress at `nowMs` (this browser's clock), extrapolated from `anchor`. */
export function progressAt(
  anchor: ProgressAnchor,
  nowMs: number,
): ProgressValue {
  const elapsedSeconds = Math.max(0, nowMs - anchor.atMs) / 1000;
  const run = anchor.positionSeconds + elapsedSeconds * anchor.rate;
  const { lengthSeconds } = anchor;
  const positionSeconds = Math.max(
    0,
    lengthSeconds === null ? run : Math.min(run, lengthSeconds),
  );
  return {
    positionSeconds,
    lengthSeconds,
    fraction:
      lengthSeconds === null || lengthSeconds <= 0
        ? null
        : positionSeconds / lengthSeconds,
  };
}
