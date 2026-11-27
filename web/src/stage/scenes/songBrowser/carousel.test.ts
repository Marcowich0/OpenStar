import { describe, expect, it } from "vitest";

import {
  carouselOffset,
  coverHalfWidth,
  coverPlacement,
  reachWithin,
  steppedIndex,
} from "./carousel";

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

  it("shows fewer on a side when the scene asks", () => {
    const reach = { left: 3, right: 1 };
    expect(coverPlacement(1, reach).shown).toBe(true);
    expect(coverPlacement(2, reach).shown).toBe(false);
    expect(coverPlacement(-3, reach).shown).toBe(true);
  });
});

describe("reachWithin", () => {
  it("counts the neighbours whose turned box fits on one side", () => {
    // The first neighbour: 390 px out, 340 × 0.74 turned 5°, about 136 px each side.
    expect(coverHalfWidth(1)).toBeCloseTo(136.3, 1);
    expect(reachWithin(526)).toBe(0);
    expect(reachWithin(527)).toBe(1);
    // The second ends about 820 px out.
    expect(reachWithin(819)).toBe(1);
    expect(reachWithin(821)).toBe(2);
    // Never more than the usual three.
    expect(reachWithin(5000)).toBe(3);
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
