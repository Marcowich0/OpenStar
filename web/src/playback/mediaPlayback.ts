/**
 * The playback adapter (#53, #155): it owns the one media element that plays
 * a Song and is the only code that reads the element's position. It feeds the
 * Song clock (`clock/songClock.ts`) from `requestVideoFrameCallback` with
 * video and from `currentTime` samples audio only, routes the element's sound
 * through the gain chain, begins at `#START`, stops at `#END` (else at the end
 * of the audio) and then signals, once, that the Song ended.
 *
 * Everything else reads the position through the clock's `songTime()`.
 */

import { createSongClock, type SongClock } from "../clock/songClock";
import type { GainChain } from "./gainChain";
import type { PlaybackPlan } from "./playbackPlan";

/** The part of an `HTMLMediaElement` (or `HTMLVideoElement`) the adapter uses. */
export interface PlaybackElement extends Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
> {
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/**
 * How the Song ended: it `played` out (to `#END` or the end of its audio), or
 * it was `ended` early (End). The results flow (#164/#175) acts on it; the
 * words are `SongResults.ended`'s.
 */
export type SongEnding = "played" | "ended";

export interface MediaPlaybackOptions {
  element: PlaybackElement;
  plan: PlaybackPlan;
  chain: Pick<GainChain, "connectMedia" | "setSongLoudness">;
  /**
   * How long after it is read a `currentTime` position reaches the output,
   * ms, as the browser reports it (the Stage's `AudioContext` latencies).
   */
  outputLatencyMs: () => number;
  /** Raised once when the Song ends; never after `dispose()`. */
  onEnded: (how: SongEnding) => void;
  /** The Song clock to feed; a new one for the plan's media by default. */
  clock?: SongClock;
  /** The Stage clock in ms; `performance.now()` by default. */
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export interface MediaPlayback {
  /** The Song clock this playback feeds. */
  readonly clock: SongClock;
  /**
   * Connects the element to the chain, moves it to `#START` and plays it.
   * Rejects when the browser refuses to play (no user gesture yet).
   */
  start(): Promise<void>;
  /** Pauses the element; the clock freezes on its `pause` event. */
  pause(): void;
  /** Plays the element on from where it paused (#158 adds the countdown before it). */
  resume(): Promise<void>;
  /** End: stops the Song early and signals `ended`. */
  end(): void;
  /** Stops and lets go of the element, with no signal (Skip, leaving the screen). */
  dispose(): void;
}

export function createMediaPlayback(
  options: MediaPlaybackOptions,
): MediaPlayback {
  const { element, plan, chain } = options;
  const now = options.now ?? (() => performance.now());
  const requestFrame =
    options.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame =
    options.cancelFrame ??
    ((handle) => {
      window.cancelAnimationFrame(handle);
    });
  const clock = options.clock ?? createSongClock({ media: plan.clock, now });

  let disconnect: (() => void) | null = null;
  let animationFrame: number | null = null;
  let videoFrame: number | null = null;
  let running = false;
  let finished = false;

  /** Stops at `#END`; reports whether it did. */
  function checkEnd(): boolean {
    if (plan.endSeconds !== null && element.currentTime >= plan.endSeconds) {
      finish("played");
      return true;
    }
    return false;
  }

  function onAnimationFrame() {
    animationFrame = null;
    if (!running) return;
    if (!element.paused) {
      // Stopping at `#END` ends the loop too.
      if (checkEnd()) return;
      if (plan.clock === "audio") {
        clock.observeCurrentTime({
          currentTime: element.currentTime,
          stageTime: now() + options.outputLatencyMs(),
        });
      }
    }
    animationFrame = requestFrame(onAnimationFrame);
  }

  const onVideoFrame: VideoFrameRequestCallback = (_, metadata) => {
    videoFrame = null;
    if (!running) return;
    clock.observeFrame({
      mediaTime: metadata.mediaTime,
      expectedDisplayTime: metadata.expectedDisplayTime,
    });
    requestVideoFrame();
  };

  function requestVideoFrame() {
    if (plan.clock === "video" && element.requestVideoFrameCallback) {
      videoFrame = element.requestVideoFrameCallback(onVideoFrame);
    }
  }

  const listeners: Record<string, () => void> = {
    // Only now does the media really play: the clock starts here, also after a stall.
    playing: () => {
      clock.play();
    },
    waiting: () => {
      clock.stall();
    },
    pause: () => {
      clock.pause();
    },
    ended: () => {
      finish("played");
    },
    timeupdate: () => {
      if (running) checkEnd();
    },
  };

  function stopLoops() {
    running = false;
    if (animationFrame !== null) cancelFrame(animationFrame);
    animationFrame = null;
    if (videoFrame !== null) element.cancelVideoFrameCallback?.(videoFrame);
    videoFrame = null;
  }

  function release() {
    stopLoops();
    for (const [type, listener] of Object.entries(listeners)) {
      element.removeEventListener(type, listener);
    }
    element.pause();
    clock.pause();
  }

  function finish(how: SongEnding) {
    if (finished) return;
    finished = true;
    release();
    options.onEnded(how);
  }

  return {
    clock,
    async start() {
      disconnect = chain.connectMedia(element as unknown as HTMLMediaElement);
      chain.setSongLoudness(plan.loudnessLufs);
      for (const [type, listener] of Object.entries(listeners)) {
        element.addEventListener(type, listener);
      }
      element.currentTime = plan.startSeconds;
      clock.seek(plan.startSeconds);
      running = true;
      animationFrame = requestFrame(onAnimationFrame);
      requestVideoFrame();
      await element.play();
    },
    pause() {
      element.pause();
    },
    async resume() {
      if (!finished) await element.play();
    },
    end() {
      finish("ended");
    },
    dispose() {
      if (!finished) {
        finished = true;
        release();
      }
      disconnect?.();
      disconnect = null;
    },
  };
}
