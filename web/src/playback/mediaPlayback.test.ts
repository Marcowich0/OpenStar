import { describe, expect, it, vi } from "vitest";

import type { SongClock } from "../clock/songClock";
import {
  createMediaPlayback,
  type MediaPlaybackOptions,
  type PlaybackElement,
} from "./mediaPlayback";
import type { PlaybackPlan } from "./playbackPlan";

/** A media element whose position and events the test sets by hand. */
class FakeMedia extends EventTarget implements PlaybackElement {
  currentTime = 0;
  paused = true;
  playCalls = 0;
  frameCallback: VideoFrameRequestCallback | null = null;
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  /** The browser reports an event. */
  fire(type: string) {
    if (type === "ended") this.paused = true;
    this.dispatchEvent(new Event(type));
  }
}

class FakeVideo extends FakeMedia {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    this.frameCallback = callback;
    return 1;
  }
  cancelVideoFrameCallback() {
    this.frameCallback = null;
  }
  /** The browser shows a frame. */
  showFrame(mediaTime: number, expectedDisplayTime: number) {
    const callback = this.frameCallback;
    this.frameCallback = null;
    callback?.(expectedDisplayTime - 8, {
      mediaTime,
      expectedDisplayTime,
    } as VideoFrameCallbackMetadata);
  }
}

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    element: "audio",
    url: "/api/songs/1/media/audio",
    clock: "audio",
    startSeconds: 0,
    endSeconds: null,
    loudnessLufs: null,
    ...overrides,
  };
}

/** Everything the adapter is handed, with animation frames run by the test. */
function setUp(
  element: FakeMedia,
  playbackPlan: PlaybackPlan,
  extra: Partial<MediaPlaybackOptions> = {},
) {
  let now = 1000;
  let frame: FrameRequestCallback | null = null;
  const chain = {
    disconnected: 0,
    connected: [] as unknown[],
    loudness: [] as (number | null)[],
    connectMedia(media: HTMLMediaElement) {
      chain.connected.push(media);
      return () => {
        chain.disconnected += 1;
      };
    },
    setSongLoudness(lufs: number | null) {
      chain.loudness.push(lufs);
    },
  };
  const onEnded = vi.fn();
  const playback = createMediaPlayback({
    element,
    plan: playbackPlan,
    chain,
    outputLatencyMs: () => 25,
    now: () => now,
    requestFrame: (cb) => {
      frame = cb;
      return 1;
    },
    cancelFrame: () => {
      frame = null;
    },
    onEnded,
    ...extra,
  });
  return {
    playback,
    chain,
    onEnded,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    /** Runs the next animation frame. */
    animationFrame() {
      const cb = frame;
      frame = null;
      cb?.(now);
    },
  };
}

/** A Song clock that records what it is fed. */
function recordingClock() {
  const fed: string[] = [];
  const clock = {
    observeFrame: (f: { mediaTime: number; expectedDisplayTime: number }) =>
      fed.push(`frame ${String(f.mediaTime)}@${String(f.expectedDisplayTime)}`),
    observeCurrentTime: (s: { currentTime: number; stageTime: number }) =>
      fed.push(`currentTime ${String(s.currentTime)}@${String(s.stageTime)}`),
    play: () => fed.push("play"),
    pause: () => fed.push("pause"),
    stall: () => fed.push("stall"),
    seek: (p: number) => fed.push(`seek ${String(p)}`),
  };
  return { fed, clock: clock as unknown as SongClock };
}

describe("starting a Song", () => {
  it("routes the element through the gain chain at the Song's loudness", async () => {
    const media = new FakeMedia();
    const { playback, chain } = setUp(media, plan({ loudnessLufs: -24 }));
    await playback.start();
    expect(chain.connected).toEqual([media]);
    expect(chain.loudness).toEqual([-24]);
    expect(media.playCalls).toBe(1);
  });

  it("begins at #START, on the element and on the clock", async () => {
    const media = new FakeMedia();
    const { playback } = setUp(media, plan({ startSeconds: 12.5 }));
    await playback.start();
    expect(media.currentTime).toBe(12.5);
    expect(playback.clock.songTime()).toBe(12.5);
  });

  it("starts the clock only once the media really plays", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ startSeconds: 3 }));
    await s.playback.start();
    s.advance(500);
    expect(s.playback.clock.songTime()).toBe(3);
    media.fire("playing");
    s.advance(500);
    expect(s.playback.clock.songTime()).toBeCloseTo(3.5, 9);
  });
});

describe("feeding the Song clock", () => {
  it("audio only: samples currentTime each frame, stamped with the output latency", async () => {
    const media = new FakeMedia();
    const { fed, clock } = recordingClock();
    const s = setUp(media, plan(), { clock });
    await s.playback.start();
    media.fire("playing");
    s.advance(16);
    media.currentTime = 0.25;
    s.animationFrame();
    s.advance(16);
    media.currentTime = 0.5;
    s.animationFrame();
    expect(fed).toEqual([
      "seek 0",
      "play",
      "currentTime 0.25@1041",
      "currentTime 0.5@1057",
    ]);
  });

  it("audio only: the clock follows the media's position", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    // The media runs 30 ms ahead of the clock's start: the clock catches up.
    // A sample reaches the output 25 ms after it is read.
    for (let i = 0; i < 200; i += 1) {
      s.advance(10);
      media.currentTime = (s.now - 1000 + 30 + 25) / 1000;
      s.animationFrame();
    }
    expect(s.playback.clock.songTime()).toBeCloseTo(2.03, 3);
  });

  it("with video: feeds frame callbacks and never currentTime", async () => {
    const media = new FakeVideo();
    const { fed, clock } = recordingClock();
    const s = setUp(media, plan({ element: "video", clock: "video" }), {
      clock,
    });
    await s.playback.start();
    media.fire("playing");
    media.currentTime = 0.04;
    media.showFrame(0.033, 1050);
    s.animationFrame();
    media.showFrame(0.066, 1066);
    expect(fed).toEqual([
      "seek 0",
      "play",
      "frame 0.033@1050",
      "frame 0.066@1066",
    ]);
  });

  it("freezes the clock on a stall and on a pause", async () => {
    const media = new FakeMedia();
    const { fed, clock } = recordingClock();
    const s = setUp(media, plan(), { clock });
    await s.playback.start();
    media.fire("playing");
    media.fire("waiting");
    media.fire("playing");
    s.playback.pause();
    expect(media.paused).toBe(true);
    expect(fed).toEqual(["seek 0", "play", "stall", "play", "pause"]);
  });

  it("does not sample a paused element", async () => {
    const media = new FakeMedia();
    const { fed, clock } = recordingClock();
    const s = setUp(media, plan(), { clock });
    await s.playback.start();
    media.paused = true;
    s.animationFrame();
    expect(fed).toEqual(["seek 0"]);
  });
});

describe("the end of the Song", () => {
  it("stops at #END and signals that the Song played out, once", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ startSeconds: 1, endSeconds: 2.5 }));
    await s.playback.start();
    media.fire("playing");
    media.currentTime = 2.49;
    s.animationFrame();
    expect(s.onEnded).not.toHaveBeenCalled();
    media.currentTime = 2.51;
    s.animationFrame();
    expect(media.paused).toBe(true);
    expect(s.playback.clock.playing).toBe(false);
    expect(s.onEnded).toHaveBeenCalledExactlyOnceWith("played");
    media.fire("ended");
    s.animationFrame();
    expect(s.onEnded).toHaveBeenCalledOnce();
  });

  it("also stops at #END between animation frames", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ endSeconds: 2 }));
    await s.playback.start();
    media.fire("playing");
    media.currentTime = 2.1;
    media.fire("timeupdate");
    expect(s.onEnded).toHaveBeenCalledExactlyOnceWith("played");
  });

  it("without #END plays on to the end of the audio", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    media.currentTime = 600;
    s.animationFrame();
    expect(s.onEnded).not.toHaveBeenCalled();
    expect(media.paused).toBe(false);
    media.fire("ended");
    expect(s.playback.clock.playing).toBe(false);
    expect(s.onEnded).toHaveBeenCalledExactlyOnceWith("played");
  });

  it("End stops the Song and signals that it was ended, once", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    s.playback.end();
    s.playback.end();
    media.fire("ended");
    expect(media.paused).toBe(true);
    expect(s.onEnded).toHaveBeenCalledExactlyOnceWith("ended");
  });

  it("dispose stops everything without a signal", async () => {
    const media = new FakeVideo();
    const { fed, clock } = recordingClock();
    const s = setUp(media, plan({ element: "video", clock: "video" }), {
      clock,
    });
    await s.playback.start();
    media.fire("playing");
    s.playback.dispose();
    media.fire("ended");
    media.showFrame(1, 2000);
    s.animationFrame();
    expect(media.paused).toBe(true);
    expect(s.chain.disconnected).toBe(1);
    expect(s.onEnded).not.toHaveBeenCalled();
    // The clock freezes and is fed nothing more.
    expect(fed).toEqual(["seek 0", "play", "pause"]);
  });
});

/** Records every position written to `media` (a seek). */
function recordSeeks(media: FakeMedia) {
  const seeks: number[] = [];
  let position = media.currentTime;
  Object.defineProperty(media, "currentTime", {
    get: () => position,
    set: (next: number) => {
      position = next;
      seeks.push(next);
    },
  });
  return {
    seeks,
    /** The media itself moves on (playing), without a seek. */
    advanceTo(next: number) {
      position = next;
    },
  };
}

describe("Restart", () => {
  it("seeks the element and the clock back to #START and marks the Restart", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ startSeconds: 12.5 }));
    await s.playback.start();
    media.fire("playing");
    s.advance(4000);
    media.currentTime = 16.5;
    void s.playback.restart();
    expect(media.currentTime).toBe(12.5);
    expect(s.playback.clock.songTime()).toBe(12.5);
    expect(s.playback.clock.lastSeekAt).toBe(s.now);
  });

  it("holds Song time at #START until the seek lands, then runs on", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ startSeconds: 2 }));
    await s.playback.start();
    media.fire("playing");
    s.advance(3000);
    void s.playback.restart();
    // The element is still seeking: a `playing` now says nothing about Song time.
    media.fire("playing");
    s.advance(200);
    expect(s.playback.clock.songTime()).toBe(2);
    media.fire("seeked");
    s.advance(500);
    expect(s.playback.clock.songTime()).toBeCloseTo(2.5, 9);
  });

  it("from a pause plays the Song again (Restart unpauses)", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    s.advance(1000);
    s.playback.pause();
    void s.playback.restart();
    expect(media.paused).toBe(false);
    expect(media.playCalls).toBe(2);
    media.fire("seeked");
    s.advance(250);
    expect(s.playback.clock.songTime()).toBeCloseTo(0.25, 9);
  });

  it("does nothing once the Song has ended", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan({ startSeconds: 1 }));
    await s.playback.start();
    media.fire("playing");
    media.currentTime = 30;
    s.playback.end();
    void s.playback.restart();
    expect(media.currentTime).toBe(30);
    expect(media.paused).toBe(true);
  });

  it("is the only seek: pause, resume, stalls and the end never move the element", async () => {
    const media = new FakeMedia();
    const recorded = recordSeeks(media);
    const s = setUp(media, plan({ startSeconds: 4, endSeconds: 60 }));
    await s.playback.start();
    media.fire("playing");
    recorded.advanceTo(10);
    s.animationFrame();
    s.playback.pause();
    await s.playback.resume();
    media.fire("playing");
    media.fire("waiting");
    media.fire("playing");
    media.fire("timeupdate");
    expect(recorded.seeks).toEqual([4]);
    void s.playback.restart();
    expect(recorded.seeks).toEqual([4, 4]);
    s.playback.end();
    expect(recorded.seeks).toEqual([4, 4]);
  });
});
