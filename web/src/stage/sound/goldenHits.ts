// The golden Note glint (`goldenHit`, #262) plays while a golden Note is hit,
// which the scoring reports many times a second: at most once per
// `GOLDEN_HIT_INTERVAL_MS` per seat, so several Players on golden Notes each
// get their own soft glint without a buzz.

/** The shortest time between two glints of one seat, ms. */
export const GOLDEN_HIT_INTERVAL_MS = 250;

export interface GoldenHitsOptions {
  /** Plays the glint (`sounds.goldenHit`). */
  play: () => void;
  /** The Stage clock, ms (`performance.now`). */
  now: () => number;
}

export interface GoldenHits {
  /** Seat `seat` is hitting a golden Note now. */
  hit(seat: number): void;
}

export function createGoldenHits({ play, now }: GoldenHitsOptions): GoldenHits {
  const last = new Map<number, number>();
  return {
    hit(seat) {
      const at = now();
      const before = last.get(seat);
      if (before !== undefined && at - before < GOLDEN_HIT_INTERVAL_MS) return;
      last.set(seat, at);
      play();
    },
  };
}
