import { describe, expect, it } from "vitest";

import { carouselOffset, coverPlacement, steppedIndex } from "./carousel";

describe("carouselOffset", () => {
  it("counts steps from the selected Song, the short way round", () => {
    // Ten Songs, the fourth selected.
    expect(carouselOffset(3, 3, 10)).toBe(0);
    expect(carouselOffset(5, 3, 10)).toBe(2);
    expect(carouselOffset(1, 3, 10)).toBe(-2);
    // Wrapping round: the last Song sits left of the first.
    expect(carouselOffset(9, 0, 10)).toBe(-1);
    expect(carouselOffset(0, 9, 10)).toBe(1);
  });

  it("puts each of a few Songs at its own place", () => {
    expect([0, 1, 2].map((i) => carouselOffset(i, 0, 3))).toEqual([0, 1, -1]);
    expect([0, 1].map((i) => carouselOffset(i, 1, 2))).toEqual([-1, 0]);
  });
});

describe("coverPlacement", () => {
  it("shows the selected cover in the middle at 1.22 ×, upright", () => {
    expect(coverPlacement(0)).toEqual({
      x: 0,
      y: 0,
      scale: 1.22,
      rotate: 0,
      z: 100,
      shown: true,
    });
  });

  it("steps neighbours out about 300 px apart, lower, smaller and tilted 5° per step", () => {
    expect(coverPlacement(1)).toEqual({
      x: 390,
      y: 26,
      scale: 0.74,
      rotate: 5,
      z: 99,
      shown: true,
    });
    expect(coverPlacement(-2)).toMatchObject({
      x: -690,
      y: 52,
      rotate: -10,
      z: 98,
    });
    expect(coverPlacement(-2).scale).toBeCloseTo(0.66);
    expect(coverPlacement(3)).toMatchObject({ x: 990, y: 78, rotate: 15 });
    expect(coverPlacement(3).scale).toBeCloseTo(0.58);
  });

  it("shows up to three on each side and never scales under 0.5", () => {
    expect(coverPlacement(3).shown).toBe(true);
    expect(coverPlacement(4).shown).toBe(false);
    expect(coverPlacement(-4).shown).toBe(false);
    expect(coverPlacement(5).scale).toBe(0.5);
  });
});

describe("steppedIndex", () => {
  it("steps the selection, wrapping round", () => {
    expect(steppedIndex(0, 1, 4)).toBe(1);
    expect(steppedIndex(3, 1, 4)).toBe(0);
    expect(steppedIndex(0, -1, 4)).toBe(3);
    expect(steppedIndex(0, 1, 0)).toBe(0);
  });
});
