/**
 * The playback adapter (#53, #155): it owns the one media element that plays
 * a Song and is the only code that reads the element's position. It feeds the
 * Song clock (`clock/songClock.ts`) from `requestVideoFrameCallback` with
 * video and from `currentTime` samples audio only, routes the element's sound
 * through the gain chain, begins at `#START`, stops at `#END` (else at the end
 * of the audio) and then signals, once, that the Song ended.
 *
 * Everything else reads the position through the clock's `songTime()`.
 *
 * The adapter is also the only code that moves the element: once to `#START`
 * when the Song starts, and again on Restart (#158), the sing screen's only
 * seek. Pause, resume and stalls never seek, so the media and the clock carry
 * on from where they stopped.
 *
 * With separate audio and video files (#212) the audio is the clock and the
 * adapter also moves the muted video that follows it: each animation frame
 * it aims the video at *Song time + `#VIDEOGAP`* (`videoFollow.ts`: a small
 * `playbackRate` change for small drift, a seek over 50 ms), holds it at its
 * start while that is before position 0 (`onVideoShown(false)`: the
 * background shows), and pauses it whenever the audio does not really play
 * (pause, stall, a Restart's seek, the end).
 *
 * The Timing editor (#220) also starts it from any position, seeks it
 * (`seek`) and changes its speed (`setRate`: the element's `playbackRate`
 * with `preservesPitch` on, the clock's rate, and the following video's
 * speed with them).
 *
 * It also reports where the Song stands (`onReport`, #159), only on events:
 * when the Song really starts, pauses, really resumes, lands a Restart's
 * seek and ends. Never per frame, and not on a stall or its recovery: the
 * Remotes extrapolate between reports.
 */

import { createSongClock, type SongClock } from "../clock/songClock";
import type { GainChain } from "./gainChain";
import type { PlaybackPlan } from "./playbackPlan";
import { followVideo } from "./videoFollow";

/** The part of an `HTMLMediaElement` (or `HTMLVideoElement`) the adapter uses. */
export interface PlaybackElement extends Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
> {
  currentTime: number;
  readonly paused: boolean;
  /** Set by `setRate` only (the Timing editor's speeds). */
  playbackRate?: number;
  preservesPitch?: boolean;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/** The part of the following `<video>` (#212) the adapter uses. */
export interface FollowingVideoElement {
  currentTime: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly duration: number;
  playbackRate: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

/**
 * How the Song ended: it `played` out (to `#END` or the end of its audio), or
 * it was `ended` early (End). The results flow (#164/#175) acts on it; the
 * words are `SongResults.ended`'s.
 */
export type SongEnding = "played" | "ended";

/** Where the Song stood at an event, and how fast it runs on from there. */
export interface PositionReport {
  /** Song time, seconds. */
  positionSeconds: number;
  /** 1 (the clock's rate) while it plays; 0 once paused or ended. */
  rate: number;
}

export interface MediaPlaybackOptions {
  element: PlaybackElement;
  plan: PlaybackPlan;
  chain: Pick<GainChain, "connectMedia" | "setSongLoudness">;
  /**
   * How long after it is read a `currentTime` position reaches the output,
   * ms, as the browser reports it (the Stage's `AudioContext` latencies).
   */
  outputLatencyMs: () => number;
  /**
   * Raised on start, pause, resume, Restart and end only (#159): when the
   * media really plays after `start()`, `resume()` or `restart()`, when a
   * `pause()` lands, and when the Song ends (before `onEnded`).
   */
  onReport?: (report: PositionReport) => void;
  /** Raised once when the Song ends; never after `dispose()`. */
  onEnded: (how: SongEnding) => void;
  /**
   * The muted video that follows the audio, for a plan with `follow`
   * (separate audio and video files, #212). Ignored without `plan.follow`.
   */
  video?: FollowingVideoElement | null;
  /**
   * Whether the following video shows (`true` once its position reached 0),
   * raised on each change; it starts hidden, behind the background.
   */
  onVideoShown?: (shown: boolean) => void;
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
   * Connects the element to the chain, moves it to `#START` (or to
   * `fromSeconds`, the Timing editor's playhead) and plays it. Rejects when
   * the browser refuses to play (no user gesture yet).
   */
  start(fromSeconds?: number): Promise<void>;
  /** Pauses the element; the clock freezes on its `pause` event. */
  pause(): void;
  /**
   * Plays the element on from where it paused. The resume countdown runs
   * before this (`stage/playback/songControls.ts`); the clock starts on the
   * element's `playing` event, so it stays frozen until then.
   */
  resume(): Promise<void>;
  /**
   * Restart: seeks the element and the clock back to `#START` and plays,
   * also from a pause. The clock marks the seek (`lastSeekAt`), so readings
   * from before it are dropped, and holds Song time at `#START` until the
   * element's seek lands (`seeked`). Does nothing once the Song has ended.
   * Rejects like `start()` when the browser refuses to play.
   */
  restart(): Promise<void>;
  /**
   * The Timing editor's seek (#220): moves the element and the clock to
   * `seconds`, like Restart, but plays only if it was playing. Song time
   * holds there until the element's seek lands.
   */
  seek(seconds: number): void;
  /**
   * The Timing editor's speed (#220): the element plays at `rate` with its
   * pitch kept, the clock runs at `rate`, and a following video keeps up.
   */
  setRate(rate: number): void;
  /**
   * The Timing editor's typed `#VIDEOGAP` (#220): a following video follows
   * at audio position + `seconds` from now on.
   */
  setVideoGap(seconds: number): void;
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
  /** A Restart's seek has not landed yet: `playing` says nothing until it does. */
  let seeking = false;
  /** A start, resume or Restart is reported once the media really plays. */
  let reportWhenPlaying = false;
  /** A `pause()` is reported once the element's `pause` lands. */
  let pausing = false;
  /** The audio really plays (the clock runs): the following video may play. */
  let audioPlays = false;
  const video = plan.follow ? (options.video ?? null) : null;
  let gapSeconds = plan.follow?.gapSeconds ?? 0;
  let videoShown = false;

  function showVideo(shown: boolean) {
    if (shown === videoShown) return;
    videoShown = shown;
    options.onVideoShown?.(shown);
  }

  /** One step of the following video after the audio (#212). */
  function follow() {
    if (!video) return;
    if (!audioPlays) {
      if (!video.paused) video.pause();
      return;
    }
    // A resync is still landing: its position says nothing yet.
    if (video.seeking) return;
    const step = followVideo({
      audioSeconds: clock.songTime(),
      videoSeconds: video.currentTime,
      gapSeconds,
      videoDurationSeconds: video.duration,
    });
    switch (step.kind) {
      case "before":
        if (!video.paused) video.pause();
        if (video.currentTime !== 0) video.currentTime = 0;
        showVideo(false);
        return;
      case "after":
        return;
      case "seek":
        video.playbackRate = clock.rate;
        video.currentTime = step.toSeconds;
        break;
      case "rate":
        video.playbackRate = step.rate * clock.rate;
        break;
    }
    showVideo(true);
    if (video.paused) {
      // Muted, so the browser lets it play; a refusal is retried next frame.
      video.play().catch(() => undefined);
    }
  }

  /** The audio stops really playing: the video stops with it. */
  function audioStops() {
    audioPlays = false;
    follow();
  }

  function report(rate: number) {
    options.onReport?.({ positionSeconds: clock.songTime(), rate });
  }

  /** The media really plays: the clock starts, and a pending event is reported. */
  function played() {
    clock.play();
    audioPlays = true;
    follow();
    if (reportWhenPlaying) {
      reportWhenPlaying = false;
      report(clock.rate);
    }
  }

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
    follow();
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
      if (!seeking) played();
    },
    seeked: () => {
      if (!seeking) return;
      seeking = false;
      if (!element.paused) played();
    },
    waiting: () => {
      clock.stall();
      audioStops();
    },
    pause: () => {
      clock.pause();
      audioStops();
      if (pausing) {
        pausing = false;
        reportWhenPlaying = false;
        report(0);
      }
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
    audioStops();
    if (video) video.playbackRate = 1;
  }

  function finish(how: SongEnding) {
    if (finished) return;
    finished = true;
    release();
    report(0);
    options.onEnded(how);
  }

  /** Moves the element and the clock; Song time holds until the seek lands. */
  function seekTo(seconds: number) {
    clock.pause();
    audioStops();
    seeking = true;
    pausing = false;
    element.currentTime = seconds;
    clock.seek(seconds);
  }

  return {
    clock,
    async start(fromSeconds = plan.startSeconds) {
      disconnect = chain.connectMedia(element as unknown as HTMLMediaElement);
      // The audio carries the sound; the video never plays its own.
      if (video) video.muted = true;
      chain.setSongLoudness(plan.loudnessLufs);
      for (const [type, listener] of Object.entries(listeners)) {
        element.addEventListener(type, listener);
      }
      element.currentTime = fromSeconds;
      clock.seek(fromSeconds);
      running = true;
      reportWhenPlaying = true;
      animationFrame = requestFrame(onAnimationFrame);
      requestVideoFrame();
      await element.play();
    },
    pause() {
      pausing = !finished;
      element.pause();
    },
    async resume() {
      if (finished) return;
      pausing = false;
      reportWhenPlaying = true;
      await element.play();
    },
    async restart() {
      if (finished || !running) return;
      // Freeze first, so Song time jumps back to `#START` and waits there.
      seekTo(plan.startSeconds);
      reportWhenPlaying = true;
      if (element.paused) await element.play();
    },
    seek(seconds) {
      if (finished || !running) return;
      seekTo(seconds);
    },
    setRate(rate) {
      element.preservesPitch = true;
      element.playbackRate = rate;
      clock.setRate(rate);
      follow();
    },
    setVideoGap(seconds) {
      gapSeconds = seconds;
      follow();
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
