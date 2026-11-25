import { describe, expect, it } from "vitest";

import { createSongClock } from "./songClock";

/** A fake Stage clock: Stage time in milliseconds, moved by hand. */
function stage(startMs = 1000) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

describe("Song time before and during play", () => {
  it("starts at 0 and stays there until play", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    expect(clock.songTime()).toBe(0);
    s.advance(2000);
    expect(clock.songTime()).toBe(0);
  });

  it("advances one second of audio per second of Stage time at rate 1", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1500);
    expect(clock.songTime()).toBeCloseTo(1.5, 9);
  });
});

describe("pause and stall", () => {
  it.each(["pause", "stall"] as const)(
    "after a %s, Song time stays frozen and play continues from exactly there",
    (event) => {
      const s = stage();
      const clock = createSongClock({ media: "audio", now: s.now });
      clock.play();
      s.advance(1234);
      clock[event]();
      const frozen = clock.songTime();
      expect(frozen).toBeCloseTo(1.234, 9);
      s.advance(3000);
      expect(clock.songTime()).toBe(frozen);
      clock.play();
      expect(clock.songTime()).toBe(frozen);
      s.advance(500);
      expect(clock.songTime()).toBeCloseTo(frozen + 0.5, 9);
    },
  );

  it("ignores observations while paused", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1000);
    clock.pause();
    clock.observeCurrentTime({ currentTime: 7, stageTime: s.now() });
    s.advance(100);
    expect(clock.songTime()).toBeCloseTo(1, 9);
  });
});

describe("seek (Restart)", () => {
  it("re-anchors at the new position, moving Song time backwards, and keeps playing", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(4000);
    clock.seek(0);
    expect(clock.songTime()).toBe(0);
    s.advance(250);
    expect(clock.songTime()).toBeCloseTo(0.25, 9);
  });

  it("while paused, moves the frozen position", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.seek(12);
    s.advance(1000);
    expect(clock.songTime()).toBe(12);
  });
});

describe("rate", () => {
  it.each([0.75, 0.5])("at rate %s Song time advances at that rate", (rate) => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.setRate(rate);
    clock.play();
    s.advance(2000);
    expect(clock.songTime()).toBeCloseTo(2 * rate, 9);
    expect(clock.rate).toBe(rate);
  });

  it("a rate change mid-play re-anchors without a jump", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1000);
    const before = clock.songTime();
    clock.setRate(0.5);
    expect(clock.songTime()).toBe(before);
    s.advance(1000);
    expect(clock.songTime()).toBeCloseTo(1.5, 9);
  });

  it("refuses a rate that is not positive", () => {
    const clock = createSongClock({ media: "audio", now: () => 0 });
    expect(() => {
      clock.setRate(0);
    }).toThrow();
    expect(() => {
      clock.setRate(-1);
    }).toThrow();
  });
});

/** A seeded pseudo-random source, so every stream is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const VSYNC_MS = 1000 / 144;

/** One rendered frame of a simulated Song. */
interface Rendered {
  /** Stage time of the frame, ms. */
  at: number;
  /** Song time the clock reported. */
  reported: number;
  /** The true media position. */
  truth: number;
}

/**
 * Plays a Song for `durationMs` and renders at 144 Hz, feeding the clock the
 * observations a browser would give. `truth(t)` is the real media position
 * at Stage time `t` (ms). Video is 25 fps: a frame callback fires when a new
 * frame is shown, with a jittery `expectedDisplayTime`. Audio only, the
 * clock gets a `currentTime` sample every rendered frame, coarse in 20 ms
 * steps.
 */
function simulate(options: {
  media: "video" | "audio";
  truth: (t: number) => number;
  durationMs: number;
  seed?: number;
  rate?: number;
}): Rendered[] {
  const rnd = random(options.seed ?? 1);
  const s = stage(10_000);
  const start = s.now();
  const clock = createSongClock({ media: options.media, now: s.now });
  if (options.rate !== undefined) clock.setRate(options.rate);
  clock.play();
  const run: Rendered[] = [];
  let lastFrame = -1;
  for (
    let vsync = start + VSYNC_MS;
    vsync < start + options.durationMs;
    vsync += VSYNC_MS
  ) {
    // The page renders a little before the vsync, with jitter.
    const render = vsync - VSYNC_MS + 1 + rnd() * 2;
    s.set(render);
    if (options.media === "video") {
      const frame = Math.floor(Math.max(0, options.truth(vsync)) * 25);
      if (frame !== lastFrame) {
        lastFrame = frame;
        clock.observeFrame({
          mediaTime: frame / 25,
          expectedDisplayTime: vsync + (rnd() - 0.5) * 3,
        });
      }
    } else {
      const step = Math.floor(Math.max(0, options.truth(render)) / 0.02) * 0.02;
      clock.observeCurrentTime({ currentTime: step, stageTime: render });
    }
    run.push({
      at: render,
      reported: clock.songTime(),
      truth: Math.max(0, options.truth(render)),
    });
  }
  return run;
}

/** Largest frame-to-frame deviation of Song time from the ideal step, seconds. */
function jitter(run: Rendered[], rate: number) {
  let worst = 0;
  let previous: Rendered | undefined;
  for (const frame of run) {
    if (previous) {
      const ideal = ((frame.at - previous.at) / 1000) * rate;
      const step = frame.reported - previous.reported;
      worst = Math.max(worst, Math.abs(step - ideal));
    }
    previous = frame;
  }
  return worst;
}

/** Largest error against the true media position after `fromMs`, seconds. */
function error(run: Rendered[], fromMs: number) {
  const start = run[0]?.at ?? 0;
  return Math.max(
    ...run
      .filter((frame) => frame.at - start >= fromMs)
      .map((frame) => Math.abs(frame.reported - frame.truth)),
  );
}

function neverDecreases(run: Rendered[]) {
  let previous = -Infinity;
  for (const frame of run) {
    if (frame.reported < previous) return false;
    previous = frame.reported;
  }
  return true;
}

describe("following the media", () => {
  // The media really starts 30 ms after the play event, and its clock runs
  // 0.05 % fast against the Stage's.
  const truth = (t: number) => ((t - 10_000 - 30) / 1000) * 1.0005;

  it.each([
    { media: "video" as const, seed: 1 },
    { media: "video" as const, seed: 2 },
    { media: "audio" as const, seed: 3 },
    { media: "audio" as const, seed: 4 },
  ])(
    "$media (seed $seed): jitter under 1 ms and error under 10 ms against the true position",
    ({ media, seed }) => {
      const run = simulate({ media, truth, durationMs: 20_000, seed });
      expect(jitter(run, 1)).toBeLessThan(0.001);
      expect(error(run, 2000)).toBeLessThan(0.01);
      expect(neverDecreases(run)).toBe(true);
    },
  );

  it.each([
    { media: "video" as const, rate: 0.75 },
    { media: "audio" as const, rate: 0.5 },
  ])("$media at rate $rate keeps the same bounds", ({ media, rate }) => {
    const run = simulate({
      media,
      rate,
      truth: (t) => ((t - 10_000 - 30) / 1000) * rate,
      durationMs: 20_000,
    });
    expect(jitter(run, rate)).toBeLessThan(0.001);
    expect(error(run, 2000)).toBeLessThan(0.01);
  });

  it("with video, ignores currentTime samples", () => {
    const s = stage();
    const clock = createSongClock({ media: "video", now: s.now });
    clock.play();
    s.advance(1000);
    clock.observeCurrentTime({ currentTime: 9, stageTime: s.now() });
    expect(clock.songTime()).toBeCloseTo(1, 9);
  });

  it("audio only, ignores frame callbacks", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1000);
    clock.observeFrame({ mediaTime: 9, expectedDisplayTime: s.now() });
    expect(clock.songTime()).toBeCloseTo(1, 9);
  });
});

describe("drift between model and observation", () => {
  it.each(["video", "audio"] as const)(
    "%s: a 30 ms drift ahead is slewed, with no jump",
    (media) => {
      const s = stage();
      const clock = createSongClock({ media, now: s.now });
      clock.play();
      s.advance(1000);
      const before = clock.songTime();
      observe(clock, media, 1.03, s.now());
      expect(clock.songTime()).toBeCloseTo(before, 9);
      s.advance(VSYNC_MS);
      expect(clock.songTime() - before).toBeLessThan(VSYNC_MS / 1000 + 0.001);
      expect(clock.songTime() - before).toBeGreaterThan(VSYNC_MS / 1000);
      // Without further observations it converges on the observed position.
      s.advance(5000);
      expect(clock.songTime()).toBeCloseTo(1.03 + 5 + VSYNC_MS / 1000, 6);
    },
  );

  it("a 30 ms drift behind is slewed, never moving Song time backwards", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1000);
    const before = clock.songTime();
    observe(clock, "audio", 0.97, s.now());
    expect(clock.songTime()).toBeCloseTo(before, 9);
    s.advance(VSYNC_MS);
    const step = clock.songTime() - before;
    expect(step).toBeGreaterThan(VSYNC_MS / 1000 - 0.001);
    expect(step).toBeLessThan(VSYNC_MS / 1000);
    s.advance(5000);
    expect(clock.songTime()).toBeCloseTo(0.97 + 5 + VSYNC_MS / 1000, 6);
  });

  it.each(["video", "audio"] as const)(
    "%s: a 200 ms drift ahead is snapped",
    (media) => {
      const s = stage();
      const clock = createSongClock({ media, now: s.now });
      clock.play();
      s.advance(1000);
      observe(clock, media, 1.2, s.now());
      expect(clock.songTime()).toBeCloseTo(1.2, 9);
      s.advance(100);
      expect(clock.songTime()).toBeCloseTo(1.3, 9);
    },
  );

  it("a 200 ms drift behind is snapped by holding still until the media catches up", () => {
    const s = stage();
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.advance(1000);
    observe(clock, "audio", 0.8, s.now());
    expect(clock.songTime()).toBeCloseTo(1, 9);
    s.advance(150);
    expect(clock.songTime()).toBeCloseTo(1, 9);
    s.advance(100);
    expect(clock.songTime()).toBeCloseTo(1.05, 9);
  });

  it("a stream with sudden large jumps forward and back never moves Song time backwards", () => {
    let offset = 0;
    const run = simulate({
      media: "video",
      truth: (t) => {
        const elapsed = t - 10_000;
        offset = elapsed > 6000 ? 0.3 : elapsed > 3000 ? -0.2 : 0;
        return elapsed / 1000 + offset;
      },
      durationMs: 10_000,
    });
    expect(neverDecreases(run)).toBe(true);
    // Settled again after each jump.
    expect(error(run, 8000)).toBeLessThan(0.01);
  });
});

function observe(
  clock: ReturnType<typeof createSongClock>,
  media: "video" | "audio",
  position: number,
  stageTime: number,
) {
  if (media === "video") {
    clock.observeFrame({ mediaTime: position, expectedDisplayTime: stageTime });
  } else {
    clock.observeCurrentTime({ currentTime: position, stageTime });
  }
}

describe("songTimeAt(T) for past Stage times", () => {
  it("answers across a pause", () => {
    const s = stage(0);
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play(); // T = 0
    s.set(1000);
    clock.pause(); // at Song time 1
    s.set(2500);
    clock.play();
    s.set(4000);
    expect(clock.songTimeAt(500)).toBeCloseTo(0.5, 9);
    expect(clock.songTimeAt(1000)).toBeCloseTo(1, 9);
    expect(clock.songTimeAt(2000)).toBeCloseTo(1, 9);
    expect(clock.songTimeAt(3000)).toBeCloseTo(1.5, 9);
    expect(clock.songTimeAt(4000)).toBeCloseTo(2.5, 9);
  });

  it("answers across a rate change", () => {
    const s = stage(0);
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.set(2000);
    clock.setRate(0.5);
    s.set(4000);
    expect(clock.songTimeAt(1000)).toBeCloseTo(1, 9);
    expect(clock.songTimeAt(3000)).toBeCloseTo(2.5, 9);
    expect(clock.songTimeAt(4000)).toBeCloseTo(3, 9);
  });

  it("answers across a Restart with the Song time before it", () => {
    const s = stage(0);
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    s.set(3000);
    clock.seek(0);
    s.set(4000);
    expect(clock.songTimeAt(2000)).toBeCloseTo(2, 9);
    expect(clock.songTimeAt(3500)).toBeCloseTo(0.5, 9);
  });

  it("matches what songTime() reported at that moment, through a jittery stream", () => {
    const rnd = random(7);
    const s = stage(0);
    const clock = createSongClock({ media: "video", now: s.now });
    clock.play();
    const reported: { at: number; value: number }[] = [];
    for (let i = 1; i < 2000; i++) {
      s.set(i * VSYNC_MS);
      if (i % 6 === 0) {
        clock.observeFrame({
          mediaTime: Math.floor(((i * VSYNC_MS - 40) / 1000) * 25) / 25,
          expectedDisplayTime: s.now() + (rnd() - 0.5) * 3,
        });
      }
      reported.push({ at: s.now(), value: clock.songTime() });
    }
    const recent = reported.filter((r) => r.at >= s.now() - 4900);
    expect(recent.length).toBeGreaterThan(600);
    for (const r of recent) {
      expect(clock.songTimeAt(r.at)).toBeCloseTo(r.value, 9);
    }
  });

  it("cannot answer outside the last ~5 s, before the clock existed, or in the future", () => {
    const s = stage(1000);
    const clock = createSongClock({ media: "audio", now: s.now });
    clock.play();
    expect(clock.songTimeAt(999)).toBeNull();
    s.set(20_000);
    expect(clock.songTimeAt(14_000)).toBeNull();
    expect(clock.songTimeAt(15_500)).toBeCloseTo(14.5, 9);
    expect(clock.songTimeAt(20_001)).toBeNull();
  });
});
