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
  playbackRate = 1;
  preservesPitch = false;
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
    follow: null,
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
    songTime: () => 0,
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

describe("seeking and speed, for the Timing editor (ticket 220)", () => {
  it("starts from a given position", async () => {
    const media = new FakeMedia();
    const { playback } = setUp(media, plan({ startSeconds: 3 }));
    await playback.start(42);
    expect(media.currentTime).toBe(42);
    expect(playback.clock.songTime()).toBe(42);
  });

  it("seeks the element and the clock while playing, and runs on once the seek lands", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    s.advance(2000);
    s.playback.seek(30);
    expect(media.currentTime).toBe(30);
    expect(s.playback.clock.songTime()).toBe(30);
    s.advance(200);
    expect(s.playback.clock.songTime()).toBe(30);
    media.fire("seeked");
    s.advance(500);
    expect(s.playback.clock.songTime()).toBeCloseTo(30.5, 9);
  });

  it("seeks while paused and stays paused until played again", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    s.playback.pause();
    s.playback.seek(12);
    media.fire("seeked");
    s.advance(1000);
    expect(media.paused).toBe(true);
    expect(s.playback.clock.songTime()).toBe(12);
    await s.playback.resume();
    media.fire("playing");
    s.advance(1000);
    expect(s.playback.clock.songTime()).toBeCloseTo(13, 9);
  });

  it("sets the speed on the element, keeping its pitch, and on the clock", async () => {
    const media = new FakeMedia();
    const s = setUp(media, plan());
    await s.playback.start();
    media.fire("playing");
    s.playback.setRate(0.5);
    expect(media.playbackRate).toBe(0.5);
    expect(media.preservesPitch).toBe(true);
    expect(s.playback.clock.rate).toBe(0.5);
    s.advance(1000);
    expect(s.playback.clock.songTime()).toBeCloseTo(0.5, 9);
  });

  it("moves a following video to a newly typed #VIDEOGAP", async () => {
    const audio = new FakeMedia();
    const video = new FakeFollowingVideo();
    const clock = steppedClock();
    const s = setUp(
      audio,
      plan({ follow: { url: "/video.webm", gapSeconds: 0 } }),
      { video, clock: clock as unknown as SongClock },
    );
    await s.playback.start();
    audio.fire("playing");
    clock.at = 10;
    video.place(10);
    s.animationFrame();
    expect(video.seeks).toEqual([]);
    s.playback.setVideoGap(1.25);
    s.animationFrame();
    expect(video.seeks).toEqual([11.25]);
  });

  it("keeps a following video at the audio's speed", async () => {
    const audio = new FakeMedia();
    const video = new FakeFollowingVideo();
    const clock = steppedClock();
    const s = setUp(
      audio,
      plan({ follow: { url: "/video.webm", gapSeconds: 0 } }),
      { video, clock: clock as unknown as SongClock },
    );
    await s.playback.start();
    s.playback.setRate(0.75);
    audio.fire("playing");
    s.animationFrame();
    expect(video.playbackRate).toBeCloseTo(0.75, 9);
    // 20 ms ahead: slowed a little below the audio's speed.
    video.place(0.02);
    s.animationFrame();
    expect(video.playbackRate).toBeCloseTo(0.98 * 0.75, 6);
    // A large drift: a seek, back at the audio's speed.
    video.place(1);
    s.animationFrame();
    expect(video.playbackRate).toBeCloseTo(0.75, 9);
  });
});

describe("position reports", () => {
  /** A playback whose reports are recorded as `position@rate`. */
  async function reporting(playbackPlan: PlaybackPlan) {
    const media = new FakeMedia();
    const reports: string[] = [];
    const s = setUp(media, playbackPlan, {
      onReport: (report) =>
        reports.push(
          `${report.positionSeconds.toFixed(2)}@${String(report.rate)}`,
        ),
    });
    await s.playback.start();
    return { ...s, media, reports };
  }

  it("reports once when the Song really starts, at #START and rate 1", async () => {
    const s = await reporting(plan({ startSeconds: 3 }));
    expect(s.reports).toEqual([]);
    s.advance(400);
    s.media.fire("playing");
    expect(s.reports).toEqual(["3.00@1"]);
  });

  it("reports a pause at rate 0, and the resume only once the media plays again", async () => {
    const s = await reporting(plan());
    s.media.fire("playing");
    s.advance(2000);
    s.playback.pause();
    expect(s.reports).toEqual(["0.00@1", "2.00@0"]);
    // The countdown runs: nothing to report until the element plays.
    s.advance(3000);
    await s.playback.resume();
    expect(s.reports).toHaveLength(2);
    s.media.fire("playing");
    expect(s.reports).toEqual(["0.00@1", "2.00@0", "2.00@1"]);
  });

  it("reports a Restart once its seek lands, at #START", async () => {
    const s = await reporting(plan({ startSeconds: 2 }));
    s.media.fire("playing");
    s.advance(5000);
    void s.playback.restart();
    s.media.fire("playing");
    expect(s.reports).toEqual(["2.00@1"]);
    s.media.fire("seeked");
    expect(s.reports).toEqual(["2.00@1", "2.00@1"]);
  });

  it("reports a seek (Skip intro) once it lands while playing, and not one made paused", async () => {
    const s = await reporting(plan());
    s.media.fire("playing");
    s.advance(2000);
    s.playback.seek(27);
    s.media.fire("playing");
    expect(s.reports).toEqual(["0.00@1"]);
    s.media.fire("seeked");
    expect(s.reports).toEqual(["0.00@1", "27.00@1"]);

    s.playback.pause();
    s.playback.seek(40);
    s.media.fire("seeked");
    expect(s.reports).toEqual(["0.00@1", "27.00@1", "27.00@0"]);
  });

  it("reports the end at rate 0, for End and for a Song that played out", async () => {
    const ended = await reporting(plan());
    ended.media.fire("playing");
    ended.advance(1500);
    ended.playback.end();
    expect(ended.reports).toEqual(["0.00@1", "1.50@0"]);

    const played = await reporting(plan({ endSeconds: 60 }));
    played.media.fire("playing");
    played.media.currentTime = 60;
    played.media.fire("timeupdate");
    expect(played.reports).toEqual(["0.00@1", "0.00@0"]);
  });

  it("reports at no other time: frames, stalls and their recovery, Skip", async () => {
    const s = await reporting(plan({ startSeconds: 1 }));
    s.media.fire("playing");
    for (let i = 0; i < 100; i += 1) {
      s.advance(16);
      s.media.currentTime = 1 + i * 0.016;
      s.animationFrame();
      s.media.fire("timeupdate");
    }
    s.media.fire("waiting");
    s.media.fire("playing");
    s.playback.dispose();
    expect(s.reports).toEqual(["1.00@1"]);
  });
});

/** The muted video that follows separate audio (#212). */
class FakeFollowingVideo {
  paused = true;
  playbackRate = 1;
  muted = false;
  seeking = false;
  duration = Number.NaN;
  playCalls = 0;
  /** Each seek (write to `currentTime`), in order. */
  seeks: number[] = [];
  private position = 0;
  get currentTime() {
    return this.position;
  }
  set currentTime(next: number) {
    this.position = next;
    this.seeks.push(next);
  }
  /** The video moves by itself (it plays on, or hiccups): not a seek. */
  place(next: number) {
    this.position = next;
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

/** A Song clock whose Song time the test moves: it runs only while playing. */
function steppedClock() {
  const clock = {
    at: 0,
    playing: false,
    rate: 1,
    lastSeekAt: null,
    songTime: () => clock.at,
    play: () => {
      clock.playing = true;
    },
    pause: () => {
      clock.playing = false;
    },
    stall: () => {
      clock.playing = false;
    },
    seek: (position: number) => {
      clock.at = position;
    },
    setRate: (rate: number) => {
      clock.rate = rate;
    },
    observeCurrentTime: () => undefined,
    observeFrame: () => undefined,
  };
  return clock;
}

describe("a separate video following the audio (ticket 212)", () => {
  function following(gapSeconds: number, startSeconds = 0) {
    const audio = new FakeMedia();
    const video = new FakeFollowingVideo();
    const clock = steppedClock();
    const shown: boolean[] = [];
    const s = setUp(
      audio,
      plan({ startSeconds, follow: { url: "/video.webm", gapSeconds } }),
      {
        video,
        clock: clock as unknown as SongClock,
        onVideoShown: (next) => shown.push(next),
      },
    );
    return { ...s, audio, video, clock, shown };
  }

  /** Time passes: Song time runs while the clock plays, the video while it plays. */
  function run(f: ReturnType<typeof following>, ms: number) {
    f.advance(ms);
    if (f.clock.playing) f.clock.at += ms / 1000;
    if (!f.video.paused) {
      f.video.place(f.video.currentTime + (ms / 1000) * f.video.playbackRate);
    }
    f.animationFrame();
  }

  it("mutes the video, and the audio stays the clock", async () => {
    const f = following(0);
    const { fed, clock } = recordingClock();
    const s = setUp(
      f.audio,
      plan({ follow: { url: "/video.webm", gapSeconds: 0 } }),
      { video: f.video, clock },
    );
    await s.playback.start();
    f.audio.fire("playing");
    s.advance(16);
    f.audio.currentTime = 0.016;
    s.animationFrame();
    expect(f.video.muted).toBe(true);
    expect(fed).toEqual(["seek 0", "play", "currentTime 0.016@1041"]);
  });

  it("puts the video at the audio position plus #VIDEOGAP", async () => {
    const f = following(1.5);
    await f.playback.start();
    f.audio.fire("playing");
    // As the audio really plays: Song time 0 + #VIDEOGAP 1.5 s, one seek.
    expect(f.video.seeks).toEqual([1.5]);
    expect(f.video.paused).toBe(false);
    run(f, 1000);
    expect(f.video.seeks).toEqual([1.5]);
    expect(f.video.currentTime).toBeCloseTo(2.5, 9);
    expect(f.video.playbackRate).toBe(1);
  });

  it("corrects small drift by playbackRate and a large one by a seek", async () => {
    const f = following(0);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 100);
    expect(f.video.seeks).toEqual([]);
    // The video runs 20 ms ahead: slowed down a little, no seek.
    f.video.place(0.12);
    f.animationFrame();
    expect(f.video.seeks).toEqual([]);
    expect(f.video.playbackRate).toBeCloseTo(0.98, 6);
    // Now 200 ms behind (the video hiccuped): resynced with a seek, rate 1.
    f.video.place(-0.1);
    f.animationFrame();
    expect(f.video.seeks).toEqual([0.1]);
    expect(f.video.playbackRate).toBe(1);
  });

  it("does not seek again while the video's last seek is still landing", async () => {
    const f = following(0);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 500);
    f.video.seeking = true;
    f.video.place(0);
    run(f, 100);
    expect(f.video.seeks).toEqual([]);
    f.video.seeking = false;
    run(f, 16);
    expect(f.video.seeks).toHaveLength(1);
    expect(f.video.seeks[0]).toBeCloseTo(0.616, 9);
  });

  it("shows the background until the video's position reaches 0, then the video", async () => {
    // #VIDEOGAP −2 s: the video begins 2 s into the audio.
    const f = following(-2);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 1000);
    expect(f.shown).toEqual([]);
    expect(f.video.paused).toBe(true);
    run(f, 1000);
    expect(f.shown).toEqual([true]);
    expect(f.video.paused).toBe(false);
  });

  it("shows a video with #VIDEOGAP 0 from the first frame", async () => {
    const f = following(0);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 16);
    expect(f.shown).toEqual([true]);
  });

  it("pauses the video with the audio, and it follows again on resume", async () => {
    const f = following(1);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 1000);
    f.playback.pause();
    expect(f.video.paused).toBe(true);
    run(f, 5000);
    expect(f.video.paused).toBe(true);
    void f.playback.resume();
    f.audio.fire("playing");
    run(f, 500);
    expect(f.video.paused).toBe(false);
    // Song time 1.5 s, the video at 2.5 s: in step without another seek.
    expect(f.video.seeks).toEqual([1]);
    expect(f.video.currentTime).toBeCloseTo(2.5, 6);
  });

  it("holds the video still while the audio stalls", async () => {
    const f = following(0);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 1000);
    f.audio.fire("waiting");
    run(f, 16);
    expect(f.video.paused).toBe(true);
    run(f, 2000);
    f.audio.fire("playing");
    run(f, 16);
    expect(f.video.paused).toBe(false);
    // It carried on from where both stopped.
    expect(f.video.seeks).toEqual([]);
    expect(f.video.currentTime).toBeCloseTo(1.016, 9);
  });

  it("follows a Restart back to #START, behind the background again before position 0", async () => {
    const f = following(-1, 0);
    await f.playback.start();
    f.audio.fire("playing");
    run(f, 3000);
    expect(f.shown).toEqual([true]);
    void f.playback.restart();
    run(f, 16);
    expect(f.video.paused).toBe(true);
    f.audio.fire("seeked");
    run(f, 16);
    expect(f.shown).toEqual([true, false]);
    // Held at its start for the next time it shows.
    expect(f.video.currentTime).toBe(0);
    run(f, 1000);
    expect(f.shown).toEqual([true, false, true]);
    expect(f.video.paused).toBe(false);
  });

  it("stops the video when the Song ends or is left", async () => {
    const ended = following(0);
    await ended.playback.start();
    ended.audio.fire("playing");
    run(ended, 500);
    ended.playback.end();
    expect(ended.video.paused).toBe(true);

    const left = following(0);
    await left.playback.start();
    left.audio.fire("playing");
    run(left, 500);
    left.playback.dispose();
    expect(left.video.paused).toBe(true);
  });
});
