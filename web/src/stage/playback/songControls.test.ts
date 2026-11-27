import { describe, expect, it, vi } from "vitest";

import { placeReading } from "../../clock/placement";
import {
  createMediaPlayback,
  type PlaybackElement,
} from "../../playback/mediaPlayback";
import { PitchBuffer } from "../../pitch/pitchBuffer";
import {
  createSongControls,
  RESUME_COUNTDOWN,
  type SongControlsState,
} from "./songControls";

/** A media element that plays only when the test says the browser does. */
class FakeMedia extends EventTarget implements PlaybackElement {
  currentTime = 0;
  paused = true;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

/**
 * A Stage with one Song on it: the real adapter and Song clock over a fake
 * element, a Stage clock and timers the test moves by hand, one Pitch buffer
 * and one scorer.
 */
async function stage(startSeconds = 0, countdownFrom?: number) {
  let now = 10_000;
  const timers: { at: number; run: () => void }[] = [];
  const media = new FakeMedia();
  const playback = createMediaPlayback({
    element: media,
    plan: {
      element: "audio",
      url: "/song.ogg",
      clock: "audio",
      startSeconds,
      endSeconds: null,
      loudnessLufs: null,
      follow: null,
    },
    chain: { connectMedia: () => () => undefined, setSongLoudness: () => {} },
    outputLatencyMs: () => 0,
    onEnded: () => {},
    now: () => now,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  const buffer = new PitchBuffer(64);
  const scorer = { reset: vi.fn() };
  const states: SongControlsState[] = [];
  const controls = createSongControls({
    playback,
    buffers: () => [buffer],
    scorers: () => [scorer],
    onChange: (state) => states.push(state),
    ...(countdownFrom === undefined
      ? {}
      : { countdownFrom: () => countdownFrom }),
    schedule: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
  });
  await playback.start();
  media.fire("playing");

  const clock = playback.clock;
  return {
    media,
    playback,
    controls,
    clock,
    buffer,
    scorer,
    states,
    get now() {
      return now;
    },
    /** Moves the Stage clock on, running the timers that fall due. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (due === undefined || due.at > until) break;
        timers.shift();
        now = due.at;
        due.run();
      }
      now = until;
    },
    /** Places a reading captured at Stage time `at` (no Mic delay). */
    place(at: number) {
      return placeReading(clock, { captureTime: at }, 0);
    },
  };
}

describe("pause", () => {
  it("freezes Song time and the media at the same position", async () => {
    const s = await stage();
    s.advance(2000);
    s.media.currentTime = 2;
    s.controls.pause();
    expect(s.media.paused).toBe(true);
    const frozen = s.clock.songTime();
    expect(frozen).toBeCloseTo(2, 9);
    s.advance(5000);
    expect(s.clock.songTime()).toBe(frozen);
    expect(s.media.currentTime).toBe(2);
    expect(s.controls.state).toEqual({ phase: "paused" });
  });

  it("twice is the same as once", async () => {
    const s = await stage();
    s.controls.pause();
    s.controls.pause();
    expect(s.states).toEqual([{ phase: "paused" }]);
  });
});

describe("resume", () => {
  it("counts down 3, 2, 1 over exactly 3 s with Song time frozen, then plays on from the paused position", async () => {
    const s = await stage();
    s.advance(2000);
    s.controls.pause();
    const frozen = s.clock.songTime();
    s.advance(4000);

    s.controls.resume();
    expect(s.controls.state).toEqual({ phase: "countdown", count: 3 });
    expect(s.media.paused).toBe(true);
    s.advance(999);
    expect(s.controls.state).toEqual({ phase: "countdown", count: 3 });
    s.advance(1);
    expect(s.controls.state).toEqual({ phase: "countdown", count: 2 });
    s.advance(1000);
    expect(s.controls.state).toEqual({ phase: "countdown", count: 1 });
    s.advance(999);
    expect(s.media.paused).toBe(true);
    expect(s.clock.songTime()).toBe(frozen);
    s.advance(1);
    expect(RESUME_COUNTDOWN.from * RESUME_COUNTDOWN.stepMs).toBe(3000);
    // The countdown is over: the element plays on where it stopped.
    expect(s.media.paused).toBe(false);
    expect(s.media.currentTime).toBe(0);
    expect(s.controls.state).toEqual({ phase: "playing" });

    // The clock starts once the media really plays, from the frozen position.
    s.advance(50);
    expect(s.clock.songTime()).toBe(frozen);
    s.media.fire("playing");
    s.advance(500);
    expect(s.clock.songTime()).toBeCloseTo(frozen + 0.5, 9);
  });

  it("counts down from the Stage options' number, one a second", async () => {
    const s = await stage(0, 5);
    s.controls.pause();
    s.controls.resume();
    expect(s.controls.state).toEqual({ phase: "countdown", count: 5 });
    s.advance(4000);
    expect(s.controls.state).toEqual({ phase: "countdown", count: 1 });
    expect(s.media.paused).toBe(true);
    s.advance(1000);
    expect(s.controls.state).toEqual({ phase: "playing" });
    expect(s.media.paused).toBe(false);
  });

  it("with a countdown of 0 plays on at once", async () => {
    const s = await stage(0, 0);
    s.controls.pause();
    s.controls.resume();
    expect(s.media.paused).toBe(false);
    expect(s.states).toEqual([{ phase: "paused" }, { phase: "playing" }]);
  });

  it("on a Song that plays changes nothing", async () => {
    const s = await stage();
    s.controls.resume();
    expect(s.states).toEqual([]);
  });

  it("a pause during the countdown stops it, and nothing plays", async () => {
    const s = await stage();
    s.controls.pause();
    s.controls.resume();
    s.advance(1500);
    s.controls.resume();
    s.controls.pause();
    s.advance(5000);
    expect(s.media.paused).toBe(true);
    expect(s.controls.state).toEqual({ phase: "paused" });
    expect(s.states).toEqual([
      { phase: "paused" },
      { phase: "countdown", count: 3 },
      { phase: "countdown", count: 2 },
      { phase: "paused" },
    ]);
  });
});

describe("a media stall", () => {
  it("freezes Song time without a countdown and continues from the same position", async () => {
    const s = await stage();
    s.advance(1000);
    s.media.fire("waiting");
    const frozen = s.clock.songTime();
    s.advance(2000);
    expect(s.clock.songTime()).toBe(frozen);
    s.media.fire("playing");
    expect(s.controls.state).toEqual({ phase: "playing" });
    s.advance(300);
    expect(s.clock.songTime()).toBeCloseTo(frozen + 0.3, 9);
    expect(s.states).toEqual([]);
  });
});

describe("Restart", () => {
  it("seeks to #START, clears the Pitch buffers and resets the scorers", async () => {
    const s = await stage(7.5);
    s.advance(3000);
    s.buffer.push({ captureMs: 0, pitch: 60, clarity: 1, loudness: -20 }, 9.5);
    s.controls.restart();
    expect(s.media.currentTime).toBe(7.5);
    expect(s.clock.songTime()).toBe(7.5);
    expect(s.buffer.newestSongTime()).toBeNull();
    expect(s.scorer.reset).toHaveBeenCalledOnce();
    expect(s.controls.state).toEqual({ phase: "playing" });
  });

  it("from a pause or a countdown plays again at once, with no countdown", async () => {
    const s = await stage();
    s.controls.pause();
    s.controls.resume();
    s.advance(1000);
    s.controls.restart();
    expect(s.media.paused).toBe(false);
    expect(s.controls.state).toEqual({ phase: "playing" });
    // The cancelled countdown does not fire later.
    s.media.fire("seeked");
    s.advance(5000);
    expect(s.states.at(-1)).toEqual({ phase: "playing" });
    expect(s.clock.songTime()).toBeCloseTo(5, 9);
  });
});

describe("which readings reach scoring", () => {
  it("drops readings inside a pause, the countdown, a stall and before a Restart", async () => {
    const s = await stage();
    const t0 = s.now;
    s.advance(400); // playing
    s.controls.pause();
    const pausedAt = s.now;
    s.advance(600); // paused
    s.controls.resume();
    s.advance(RESUME_COUNTDOWN.from * RESUME_COUNTDOWN.stepMs); // counting down
    s.media.fire("playing");
    const resumedAt = s.now;
    s.advance(500); // playing
    // The clock answers for the last 5 s.
    expect(s.place(t0 + 200)?.songTime).toBeCloseTo(0.2, 9);
    expect(s.place(pausedAt + 300)).toBeNull();
    expect(s.place(pausedAt + 600 + 1500)).toBeNull();
    expect(s.place(resumedAt + 250)?.songTime).toBeCloseTo(0.65, 9);

    s.media.fire("waiting");
    const stalledAt = s.now;
    s.advance(400); // stalled
    s.media.fire("playing");
    const unstalledAt = s.now;
    s.advance(500);
    expect(s.place(stalledAt + 200)).toBeNull();
    expect(s.place(unstalledAt + 100)?.songTime).toBeCloseTo(1, 9);

    s.controls.restart();
    const restartedAt = s.now;
    s.media.fire("seeked");
    s.advance(300);
    expect(s.place(unstalledAt + 400)).toBeNull();
    expect(s.place(restartedAt + 100)?.songTime).toBeCloseTo(0.1, 9);
  });
});

describe("Song time", () => {
  it("never runs backwards while playing; only Restart moves it back", async () => {
    const s = await stage(1);
    const steps: (() => void)[] = [
      () => {
        s.controls.pause();
      },
      () => {
        s.controls.resume();
      },
      () => {
        s.media.fire("playing");
      },
      () => {
        s.media.fire("waiting");
      },
      () => {
        s.media.fire("seeked");
      },
      () => {
        // The media reports a position slightly behind or ahead.
        s.media.currentTime = s.clock.songTime() + 0.08 * Math.sin(s.now);
        s.playback.clock.observeCurrentTime({
          currentTime: s.media.currentTime,
          stageTime: s.now,
        });
      },
    ];
    let last = s.clock.songTime();
    let seed = 7;
    for (let i = 0; i < 2000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const restart = seed % 97 === 0;
      if (restart) s.controls.restart();
      else steps[seed % steps.length]?.();
      s.advance(seed % 400);
      const time = s.clock.songTime();
      if (restart) expect(time).toBeGreaterThanOrEqual(1);
      else expect(time).toBeGreaterThanOrEqual(last);
      last = time;
    }
  });
});
