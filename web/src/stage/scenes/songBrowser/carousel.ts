// The song browser's cover carousel geometry (v1 spec #55, "Song browser and
// join card"), in the 1920 × 1080 reference frame. Pure, so it is tested
// without a layout: the scene turns each placement into a CSS transform.

export const CAROUSEL = {
  /** Every cover is drawn this size; the selected one is scaled up. */
  coverPx: 340,
  /** The selected cover: 340 px × 1.22 ≈ 415 px square. */
  selectedScale: 1.22,
  /** Neighbours step out about 300 px apart… */
  stepPx: 300,
  /** …plus this much room on each side for the bigger selected cover. */
  selectedGapPx: 90,
  /** How much lower each step sits. */
  dropPx: 26,
  /** The tilt per step, in degrees. */
  tiltDeg: 5,
  /** Neighbours shown on each side, unless the scene asks for fewer. */
  reach: 3,
  /** The rim of the selected cover, about 9 px once scaled. */
  rimPx: 9 / 1.22,
} as const;

/**
 * Steps from the selected Song to Song `index` of `count`, the short way
 * round (the carousel wraps): negative to the left.
 */
export function carouselOffset(
  index: number,
  selected: number,
  count: number,
): number {
  let offset = index - selected;
  if (offset > count / 2) offset -= count;
  if (offset < -count / 2) offset += count;
  return offset;
}

export interface CoverPlacement {
  /** Px right of the middle. */
  x: number;
  /** Px lower than the selected cover. */
  y: number;
  scale: number;
  /** Degrees, clockwise. */
  rotate: number;
  /** Stacking: nearer the middle is on top. */
  z: number;
  /** Only the neighbours within the reach on their side are shown. */
  shown: boolean;
}

/** How many neighbours show on each side of the selected cover. */
export interface CarouselReach {
  left: number;
  right: number;
}

export const FULL_REACH: CarouselReach = {
  left: CAROUSEL.reach,
  right: CAROUSEL.reach,
};

/** Where the cover `offset` steps from the selected one sits. */
export function coverPlacement(
  offset: number,
  reach: CarouselReach = FULL_REACH,
): CoverPlacement {
  const distance = Math.abs(offset);
  const scale =
    offset === 0
      ? CAROUSEL.selectedScale
      : Math.max(0.5, round(0.82 - 0.08 * distance));
  return {
    x: offset * CAROUSEL.stepPx + Math.sign(offset) * CAROUSEL.selectedGapPx,
    y: distance * CAROUSEL.dropPx,
    scale,
    rotate: offset * CAROUSEL.tiltDeg,
    z: 100 - distance,
    shown: distance <= (offset < 0 ? reach.left : reach.right),
  };
}

/**
 * Half the width of the box the cover `offset` steps out covers, once scaled
 * and turned (its rim included).
 */
export function coverHalfWidth(offset: number): number {
  const { scale, rotate } = coverPlacement(offset);
  const turn = (Math.abs(rotate) * Math.PI) / 180;
  return (CAROUSEL.coverPx * scale * (Math.cos(turn) + Math.sin(turn))) / 2;
}

/**
 * How many neighbours on one side fit wholly within `roomPx` of the middle,
 * up to the usual reach: the song browser keeps its covers out of the join
 * card's lane this way.
 */
export function reachWithin(roomPx: number): number {
  let reach = 0;
  while (reach < CAROUSEL.reach) {
    const next = reach + 1;
    if (coverPlacement(next).x + coverHalfWidth(next) > roomPx) break;
    reach = next;
  }
  return reach;
}

/** The selection after a step of `by`, wrapping round `count` Songs. */
export function steppedIndex(
  selected: number,
  by: number,
  count: number,
): number {
  if (count === 0) return 0;
  return (((selected + by) % count) + count) % count;
}

/** Drops floating-point dust (0.82 − 0.08 = 0.7399999…). */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
