/**
 * How a Song's separate video follows its audio (#53, "Separate audio and
 * video files"): the audio is the clock, and the muted video aims at
 * *audio position + `#VIDEOGAP`*. Small drift is corrected with a small
 * `playbackRate` change, a drift over 50 ms by a seek. Pure: the playback
 * adapter (`mediaPlayback.ts`) reads both positions and applies the step.
 */

export const VIDEO_FOLLOW = {
  /** Drift beyond this (seconds, either way) resyncs the video with a seek. */
  resyncSeconds: 0.05,
  /** The rate change corrects the drift over about this long (seconds). */
  correctionSeconds: 1,
  /** The largest `playbackRate` change from 1 (±5 %). */
  maxRateChange: 0.05,
} as const;

export interface FollowInput {
  /** Where the audio stands (Song time), seconds. */
  audioSeconds: number;
  /** Where the video stands, seconds of video. */
  videoSeconds: number;
  /** `#VIDEOGAP`, seconds: video position = audio position + gap. */
  gapSeconds: number;
  /** The video's length, seconds (`NaN` or absent while unknown). */
  videoDurationSeconds?: number;
}

export type FollowStep =
  /** The video's target is before its position 0: hold it there, show the background. */
  | { kind: "before" }
  /** The target is past the video's end: leave it on its last frame. */
  | { kind: "after" }
  /** Play the video at this `playbackRate`. */
  | { kind: "rate"; rate: number }
  /** Resync: seek the video here (seconds), then play at rate 1. */
  | { kind: "seek"; toSeconds: number };

export function followVideo({
  audioSeconds,
  videoSeconds,
  gapSeconds,
  videoDurationSeconds = Number.NaN,
}: FollowInput): FollowStep {
  const target = audioSeconds + gapSeconds;
  if (target < 0) return { kind: "before" };
  if (target >= videoDurationSeconds) return { kind: "after" };
  const drift = videoSeconds - target;
  // A tiny epsilon keeps exactly 50 ms (in float) on the rate side.
  if (Math.abs(drift) > VIDEO_FOLLOW.resyncSeconds + 1e-9) {
    return { kind: "seek", toSeconds: target };
  }
  const change = Math.max(
    -VIDEO_FOLLOW.maxRateChange,
    Math.min(VIDEO_FOLLOW.maxRateChange, -drift / VIDEO_FOLLOW.correctionSeconds),
  );
  // `+ 0` turns −0 into 0.
  return { kind: "rate", rate: 1 + change + 0 };
}
