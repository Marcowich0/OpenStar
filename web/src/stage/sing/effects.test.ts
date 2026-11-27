import { describe, expect, it } from "vitest";

import type { DrawList } from "./frame";
import type { HeadBallEntry } from "./pitchTrace";
import {
  confettiBurst,
  GoldenSparkles,
  SPARKLE_RATE,
  MAX_FRAME_DELTA,
  ParticlePool,
  type ParticleEntry,
} from "./effects";

function particles(pool: ParticlePool): ParticleEntry[] {
  const list: DrawList = [];
  pool.draw(list);
  return list.filter((e): e is ParticleEntry => e.type === "particle");
}

/** A still dot at (x, 0) that lives `life` seconds, sized by its spawn order. */
function spawnAt(pool: ParticlePool, x: number, size: number, life = 10) {
  pool.spawn(x, 0, 0, 0, 0, life, size, "dot", "cherry", 0);
}

describe("the particle pool", () => {
  it("holds at most its capacity, reusing the oldest particles past it", () => {
    const pool = new ParticlePool(4, { gravity: 0 });
    for (let i = 0; i < 6; i++) spawnAt(pool, i * 100, i + 1);
    expect(pool.live).toBe(4);
    // The first two spawned are gone; the last four are drawn.
    expect(
      particles(pool)
        .map((p) => p.size)
        .sort(),
    ).toEqual([3, 4, 5, 6]);
  });

  it("allocates its storage once: spawning past capacity reuses the same memory", () => {
    const pool = new ParticlePool(64);
    const memory = pool.memory;
    const bytes = memory.byteLength;
    for (let i = 0; i < 10_000; i++) {
      confettiBurst(pool, 960, 540, "sky");
      pool.advance(1 / 144);
    }
    expect(pool.memory).toBe(memory);
    expect(pool.memory.byteLength).toBe(bytes);
    expect(pool.live).toBeLessThanOrEqual(64);
  });

  it("takes a free slot before reusing a live one", () => {
    const pool = new ParticlePool(3, { gravity: 0 });
    spawnAt(pool, 0, 1, 10);
    spawnAt(pool, 0, 2, 0.1);
    spawnAt(pool, 0, 3, 10);
    pool.advance(0.2); // the second dies
    spawnAt(pool, 0, 4, 10);
    expect(
      particles(pool)
        .map((p) => p.size)
        .sort(),
    ).toEqual([1, 3, 4]);
  });

  it("drops a particle once it has lived its life", () => {
    const pool = new ParticlePool(8, { gravity: 0 });
    spawnAt(pool, 0, 1, 0.5);
    pool.advance(0.25);
    expect(pool.live).toBe(1);
    pool.advance(0.25);
    expect(pool.live).toBe(0);
    expect(particles(pool)).toEqual([]);
  });

  it("clears every particle on clear()", () => {
    const pool = new ParticlePool(8);
    confettiBurst(pool, 100, 100, "cherry");
    pool.clear();
    expect(pool.live).toBe(0);
  });
});

describe("particle motion on real frame time", () => {
  function burstAfter(deltas: readonly number[]): ParticleEntry[] {
    const pool = new ParticlePool(64, { seed: 7 });
    confettiBurst(pool, 960, 700, "grape");
    for (const dt of deltas) pool.advance(dt);
    return particles(pool);
  }

  function steps(hz: number, seconds: number): number[] {
    return Array.from({ length: Math.round(hz * seconds) }, () => 1 / hz);
  }

  function expectSamePlaces(a: ParticleEntry[], b: ParticleEntry[]) {
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    a.forEach((p, i) => {
      const q = b[i];
      expect(Math.abs(p.x - (q?.x ?? NaN))).toBeLessThan(0.5);
      expect(Math.abs(p.y - (q?.y ?? NaN))).toBeLessThan(0.5);
    });
  }

  it("moves particles to the same places after one second at 60 Hz and at 144 Hz", () => {
    expectSamePlaces(burstAfter(steps(60, 1)), burstAfter(steps(144, 1)));
  });

  it("lands particles in the same places after a dropped frame", () => {
    // 0.2 s of frames dropped in the middle, at 60 Hz.
    const dropped = [...steps(60, 0.4), 0.2, ...steps(60, 0.4)];
    expectSamePlaces(burstAfter(dropped), burstAfter(steps(144, 1)));
  });

  it("moves under gravity: thrown up, then falling", () => {
    const pool = new ParticlePool(4, { gravity: 2000 });
    pool.spawn(100, 500, 50, -1000, 0, 5, 10, "dot", "cherry", 0);
    pool.advance(0.25);
    pool.advance(0.25);
    const [p] = particles(pool);
    // x = 100 + 50 × 0.5; y = 500 − 1000 × 0.5 + ½ × 2000 × 0.25
    expect(p?.x).toBeCloseTo(125, 6);
    expect(p?.y).toBeCloseTo(250, 6);
    pool.advance(0.25);
    pool.advance(0.25);
    expect(particles(pool)[0]?.y).toBeCloseTo(500, 6);
  });

  it("clamps a long delta, so a tab switch does not throw particles off screen", () => {
    const pool = new ParticlePool(4, { gravity: 2000 });
    pool.spawn(100, 500, 0, 0, 0, 5, 10, "dot", "cherry", 0);
    pool.advance(30); // the tab was hidden for half a minute
    const [p] = particles(pool);
    expect(p?.y).toBeCloseTo(500 + 0.5 * 2000 * MAX_FRAME_DELTA ** 2, 6);
    expect(MAX_FRAME_DELTA).toBeLessThanOrEqual(0.25);
  });

  it("ignores a negative or non-finite delta", () => {
    const pool = new ParticlePool(4, { gravity: 2000 });
    pool.spawn(100, 500, 0, 0, 0, 5, 10, "dot", "cherry", 0);
    pool.advance(-1);
    pool.advance(NaN);
    expect(particles(pool)[0]?.y).toBe(500);
  });

  it("turns a star by its spin and fades a particle out at the end of its life", () => {
    const pool = new ParticlePool(4, { gravity: 0 });
    pool.spawn(0, 0, 0, 0, 0.5, 1, 10, "star", "cherry", 2);
    pool.advance(0.25);
    let [p] = particles(pool);
    expect(p?.rotation).toBeCloseTo(1, 6);
    expect(p?.alpha).toBe(1);
    pool.advance(0.25);
    pool.advance(0.25);
    pool.advance(0.125); // 0.875 of its life: half faded
    [p] = particles(pool);
    expect(p?.alpha).toBeCloseTo(0.5, 6);
  });
});

describe("the confetti burst (#55)", () => {
  it("throws about 30 round dots and stars from the given point, in the Player's colour and the accents", () => {
    const pool = new ParticlePool(256, { seed: 3 });
    confettiBurst(pool, 400, 300, "teal");
    const burst = particles(pool);
    expect(burst).toHaveLength(30);
    for (const p of burst) {
      expect(p).toMatchObject({ x: 400, y: 300, alpha: 1 });
      expect(p.size).toBeGreaterThanOrEqual(8);
      expect(p.size).toBeLessThanOrEqual(20);
    }
    const stars = burst.filter((p) => p.shape === "star").length;
    expect(stars).toBeGreaterThanOrEqual(5);
    expect(stars).toBeLessThanOrEqual(15);
    const colours = new Set(burst.map((p) => p.colour));
    expect(colours.has("teal")).toBe(true);
    for (const c of colours) {
      expect([
        "teal",
        "--color-red",
        "--color-blue",
        "--color-green",
        "--color-yellow",
        "--color-purple",
      ]).toContain(c);
    }
  });

  it("throws particles upwards, and they are gone within 1.3 s", () => {
    const pool = new ParticlePool(256, { seed: 3 });
    confettiBurst(pool, 400, 600, "teal");
    pool.advance(0.1);
    const early = particles(pool);
    expect(early.filter((p) => p.y < 600).length).toBe(early.length);
    for (let i = 0; i < 13; i++) pool.advance(0.1);
    expect(pool.live).toBe(0);
  });

  it("lives at least 0.6 s", () => {
    const pool = new ParticlePool(256, { seed: 3 });
    confettiBurst(pool, 400, 600, "teal");
    pool.advance(0.59);
    expect(pool.live).toBe(30);
  });

  it("is the same burst for the same seed", () => {
    const a = new ParticlePool(64, { seed: 11 });
    const b = new ParticlePool(64, { seed: 11 });
    confettiBurst(a, 10, 10, "cherry");
    confettiBurst(b, 10, 10, "cherry");
    a.advance(0.3);
    b.advance(0.3);
    expect(particles(a)).toEqual(particles(b));
  });
});

describe("the golden-Note sparkle at the head ball (#55)", () => {
  function ball(golden: boolean, lane = 0): HeadBallEntry {
    return {
      type: "headBall",
      lane,
      x: 600,
      y: 900,
      pitch: 0,
      radius: 14,
      colour: "teal",
      rim: "--color-white",
      rimWidth: 3,
      squash: { x: 1, y: 1 },
      golden,
    };
  }

  it("throws confetti from the head ball while it hits a golden Note, at a steady rate of real time", () => {
    const pool = new ParticlePool(256, { seed: 5 });
    const sparkles = new GoldenSparkles();
    sparkles.emit([ball(true)], pool, 0.25);
    expect(pool.live).toBe(Math.round(SPARKLE_RATE * 0.25));
    expect(SPARKLE_RATE).toBeGreaterThan(5);
    for (const p of particles(pool)) {
      expect(p).toMatchObject({ x: 600, y: 900 });
      expect(p.size).toBeGreaterThanOrEqual(8);
      expect(p.size).toBeLessThanOrEqual(20);
      expect([
        "teal",
        "--color-red",
        "--color-blue",
        "--color-green",
        "--color-yellow",
        "--color-purple",
      ]).toContain(p.colour);
    }
  });

  it("spawns the same number at 144 Hz as in one long frame", () => {
    const smooth = new ParticlePool(256);
    const s = new GoldenSparkles();
    for (let i = 0; i < 144; i++) s.emit([ball(true)], smooth, 1 / 144);
    const jumpy = new ParticlePool(256);
    const j = new GoldenSparkles();
    for (let i = 0; i < 4; i++) j.emit([ball(true)], jumpy, 0.25);
    expect(smooth.live).toBe(SPARKLE_RATE);
    expect(jumpy.live).toBe(SPARKLE_RATE);
  });

  it("is quiet on a Normal Note, without a head ball, and on a frozen frame", () => {
    const pool = new ParticlePool(256);
    const sparkles = new GoldenSparkles();
    sparkles.emit([ball(false)], pool, 1);
    sparkles.emit([], pool, 1);
    sparkles.emit([ball(true)], pool, 0);
    expect(pool.live).toBe(0);
  });

  it("starts each golden stretch afresh, lane by lane", () => {
    const pool = new ParticlePool(256);
    const sparkles = new GoldenSparkles();
    // Lane 1 sparkles; lane 0 is between golden Notes.
    sparkles.emit([ball(false, 0), ball(true, 1)], pool, 0.25);
    expect(pool.live).toBe(Math.round(SPARKLE_RATE * 0.25));
  });

  it("never allocates pool memory", () => {
    const pool = new ParticlePool(16);
    const memory = pool.memory;
    const sparkles = new GoldenSparkles();
    for (let i = 0; i < 1000; i++) sparkles.emit([ball(true)], pool, 0.1);
    expect(pool.memory).toBe(memory);
    expect(pool.live).toBe(16);
  });
});
