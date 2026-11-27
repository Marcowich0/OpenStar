/**
 * The sing screen's effects (#56, #55): confetti, stars and bursts, from a
 * particle pool of fixed capacity allocated once. A burst writes into slots
 * that already exist, so it never allocates; past capacity it reuses the
 * oldest particles.
 *
 * Particles move on real frame time, not Song time: the render loop advances
 * the pool by each frame's real delta, never assuming 60 Hz. A particle's
 * position is computed in closed form from its age (a throw under gravity),
 * so the same second of time puts it in the same place whether it arrives in
 * 60, 144 or 5 frames. A delta is clamped to `MAX_FRAME_DELTA`, so a tab
 * switch does not throw particles off screen.
 *
 * Live particles go into the draw list as `particle` entries (`draw`), and
 * the same painter paints them on the effects canvas. A Perfect! Line bursts
 * `confettiBurst` from the lane header (`lineRating.ts`), and the render loop
 * runs `GoldenSparkles` at the head ball while a golden Note is hit (#216).
 *
 * Sizes are in the 1920 × 1080 reference frame, times in seconds.
 */

import type { InterfaceToken, PaletteKey } from "../../theme/tokens";
import type { HeadBallEntry } from "./pitchTrace";

export type ParticleShape = "dot" | "star";

/** A Party colour, or one of the confetti accents. */
export type ParticleColour =
  | PaletteKey
  | Extract<
      InterfaceToken,
      | "--color-red"
      | "--color-blue"
      | "--color-green"
      | "--color-yellow"
      | "--color-purple"
    >;

/** One live particle, as the painter draws it on the effects canvas. */
export interface ParticleEntry {
  type: "particle";
  /** Centre, reference frame. */
  x: number;
  y: number;
  /** Diameter of a dot, or of a star's points. */
  size: number;
  shape: ParticleShape;
  colour: ParticleColour;
  /** Radians, clockwise (a star's turn). */
  rotation: number;
  /** 0–1: the particle fades out over the last part of its life. */
  alpha: number;
}

/** The longest frame delta the pool moves by, seconds. */
export const MAX_FRAME_DELTA = 0.25;
/** Downward acceleration, reference pixels per second². */
export const GRAVITY = 2200;
/** The share of its life over which a particle fades out, at the end. */
const FADE_SHARE = 0.25;
/** The sing screen's pool: room for many bursts at once on 8 lanes. */
export const EFFECTS_CAPACITY = 512;

/** Per-particle numbers, one `Float64Array` view each over one buffer. */
const FIELDS = 10;

export interface ParticlePoolOptions {
  /** Seeds the pool's random numbers, so a burst is repeatable. */
  seed?: number;
  /** Reference pixels per second²; `GRAVITY` by default. */
  gravity?: number;
}

export class ParticlePool {
  readonly capacity: number;
  /** All per-particle numbers. Allocated once, never replaced. */
  readonly memory: ArrayBuffer;
  private readonly gravity: number;
  private readonly x0: Float64Array;
  private readonly y0: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly rotation0: Float64Array;
  private readonly spin: Float64Array;
  private readonly age: Float64Array;
  private readonly life: Float64Array;
  private readonly size: Float64Array;
  /** Spawn order; 0 is a free slot. */
  private readonly order: Float64Array;
  private readonly shapes: ParticleShape[];
  private readonly colours: ParticleColour[];
  private spawned = 0;
  private liveCount = 0;
  private seed: number;

  constructor(capacity: number, options: ParticlePoolOptions = {}) {
    this.capacity = capacity;
    this.gravity = options.gravity ?? GRAVITY;
    this.seed = (options.seed ?? 1) >>> 0;
    this.memory = new ArrayBuffer(capacity * FIELDS * 8);
    const field = (i: number) =>
      new Float64Array(this.memory, i * capacity * 8, capacity);
    this.x0 = field(0);
    this.y0 = field(1);
    this.vx = field(2);
    this.vy = field(3);
    this.rotation0 = field(4);
    this.spin = field(5);
    this.age = field(6);
    this.life = field(7);
    this.size = field(8);
    this.order = field(9);
    this.shapes = new Array<ParticleShape>(capacity).fill("dot");
    this.colours = new Array<ParticleColour>(capacity).fill("cherry");
  }

  /** How many particles are alive. */
  get live(): number {
    return this.liveCount;
  }

  /** A repeatable random number in [0, 1) (mulberry32); allocates nothing. */
  random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Starts a particle at (`x`, `y`) with velocity (`vx`, `vy`) per second,
   * turned `rotation` radians and turning `spin` radians per second, for
   * `life` seconds. Takes a free slot, else the oldest particle's.
   */
  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    rotation: number,
    life: number,
    size: number,
    shape: ParticleShape,
    colour: ParticleColour,
    spin: number,
  ): void {
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      const order = this.order[i] ?? 0;
      if (order === 0) {
        slot = i;
        break;
      }
      if (order < oldest) {
        oldest = order;
        slot = i;
      }
    }
    if (this.order[slot] === 0) this.liveCount++;
    this.order[slot] = ++this.spawned;
    this.x0[slot] = x;
    this.y0[slot] = y;
    this.vx[slot] = vx;
    this.vy[slot] = vy;
    this.rotation0[slot] = rotation;
    this.spin[slot] = spin;
    this.age[slot] = 0;
    this.life[slot] = life;
    this.size[slot] = size;
    this.shapes[slot] = shape;
    this.colours[slot] = colour;
  }

  /**
   * Ages every particle by one frame's real delta, in seconds, clamped to
   * `MAX_FRAME_DELTA`; drops those whose life is over.
   */
  advance(delta: number): void {
    if (!(delta > 0)) return;
    const dt = Math.min(delta, MAX_FRAME_DELTA);
    for (let i = 0; i < this.capacity; i++) {
      if (this.order[i] === 0) continue;
      const age = (this.age[i] ?? 0) + dt;
      this.age[i] = age;
      if (age >= (this.life[i] ?? 0)) {
        this.order[i] = 0;
        this.liveCount--;
      }
    }
  }

  /** Drops every particle (a new Song, a restart). */
  clear(): void {
    this.order.fill(0);
    this.liveCount = 0;
  }

  /** Appends a `particle` entry per live particle, oldest first by slot. */
  draw(list: { push(entry: ParticleEntry): unknown }): void {
    if (this.liveCount === 0) return;
    const g = this.gravity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.order[i] === 0) continue;
      const t = this.age[i] ?? 0;
      const life = this.life[i] ?? 0;
      const left = life > 0 ? (life - t) / (life * FADE_SHARE) : 0;
      list.push({
        type: "particle",
        x: (this.x0[i] ?? 0) + (this.vx[i] ?? 0) * t,
        y: (this.y0[i] ?? 0) + (this.vy[i] ?? 0) * t + 0.5 * g * t * t,
        size: this.size[i] ?? 0,
        shape: this.shapes[i] ?? "dot",
        colour: this.colours[i] ?? "cherry",
        rotation: (this.rotation0[i] ?? 0) + (this.spin[i] ?? 0) * t,
        alpha: Math.min(1, Math.max(0, left)),
      });
    }
  }
}

/** The confetti accents beside the Player's own colour (#55). */
const ACCENTS: readonly ParticleColour[] = [
  "--color-red",
  "--color-blue",
  "--color-green",
  "--color-yellow",
  "--color-purple",
];

/** About 30 particles per confetti burst (#55). */
export const CONFETTI_COUNT = 30;

/**
 * #55's confetti burst at (`x`, `y`), reference frame: round dots and stars
 * (about a third stars), 8–20 px, in `colour` (half of them) and the accents,
 * thrown up within 50° of vertical and falling under gravity for 0.6–1.3 s.
 * Allocates nothing.
 */
export function confettiBurst(
  pool: ParticlePool,
  x: number,
  y: number,
  colour: ParticleColour,
  count: number = CONFETTI_COUNT,
): void {
  for (let i = 0; i < count; i++) {
    throwOne(pool, x, y, colour, i % 3 === 0, BURST_SPEED);
  }
}

/** Launch speeds, reference pixels per second: from, and how much more. */
const BURST_SPEED = { from: 600, spread: 500 } as const;
const SPARKLE_SPEED = { from: 250, spread: 250 } as const;

/** One confetti particle thrown up within 50° of vertical. */
function throwOne(
  pool: ParticlePool,
  x: number,
  y: number,
  colour: ParticleColour,
  star: boolean,
  speedRange: { readonly from: number; readonly spread: number },
): void {
  const angle = (pool.random() * 2 - 1) * (50 * (Math.PI / 180));
  const speed = speedRange.from + pool.random() * speedRange.spread;
  const own = pool.random() < 0.5;
  const accent = ACCENTS[Math.floor(pool.random() * ACCENTS.length)] ?? colour;
  pool.spawn(
    x,
    y,
    speed * Math.sin(angle),
    -speed * Math.cos(angle),
    pool.random() * 2 * Math.PI,
    0.6 + pool.random() * 0.7,
    8 + pool.random() * 12,
    star ? "star" : "dot",
    own ? colour : accent,
    (pool.random() * 2 - 1) * 6,
  );
}

/** Sparkle particles per second of real time while a golden Note is hit. */
export const SPARKLE_RATE = 24;
/** Lanes the sparkle keeps a count for (`laneLayout`'s most). */
const SPARKLE_LANES = 8;

/**
 * The sparkle at the head ball while a golden Note is being hit (#55): the
 * same confetti, thrown gently from the ball at `SPARKLE_RATE` a second of
 * real time, whatever the frame rate. The render loop calls `emit` once a
 * frame with that frame's draw list and real delta; it reads the head balls
 * the list marks `golden`. Allocates nothing.
 */
export class GoldenSparkles {
  /** Each lane's particles owed but not yet thrown (a fraction). */
  private readonly owed = new Float64Array(SPARKLE_LANES);
  private readonly active = new Uint8Array(SPARKLE_LANES);

  emit(
    list: readonly { readonly type: string }[],
    pool: ParticlePool,
    delta: number,
  ): void {
    this.active.fill(0);
    const dt = delta > 0 ? Math.min(delta, MAX_FRAME_DELTA) : 0;
    for (const entry of list) {
      if (entry.type !== "headBall") continue;
      const ball = entry as HeadBallEntry;
      if (!ball.golden || ball.lane < 0 || ball.lane >= SPARKLE_LANES) {
        continue;
      }
      this.active[ball.lane] = 1;
      let owed = (this.owed[ball.lane] ?? 0) + dt * SPARKLE_RATE;
      // A hair of slack, so 144 frames of 1/144 s owe a whole 24.
      while (owed >= 1 - 1e-9) {
        throwOne(
          pool,
          ball.x,
          ball.y,
          ball.colour,
          pool.random() < 1 / 3,
          SPARKLE_SPEED,
        );
        owed -= 1;
      }
      this.owed[ball.lane] = Math.max(0, owed);
    }
    // A lane off a golden Note starts its next golden stretch afresh.
    for (let lane = 0; lane < SPARKLE_LANES; lane++) {
      if (this.active[lane] === 0) this.owed[lane] = 0;
    }
  }
}
