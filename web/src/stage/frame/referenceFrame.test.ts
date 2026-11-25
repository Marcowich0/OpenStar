import { describe, expect, it } from "vitest";

import {
  REFERENCE_HEIGHT,
  REFERENCE_WIDTH,
  referenceScale,
} from "./referenceFrame";

describe("referenceScale", () => {
  it("is 1 on a 1920 × 1080 screen", () => {
    expect(REFERENCE_WIDTH).toBe(1920);
    expect(REFERENCE_HEIGHT).toBe(1080);
    expect(referenceScale(1920, 1080)).toBe(1);
  });

  it("scales uniformly with the screen", () => {
    expect(referenceScale(3840, 2160)).toBe(2);
    expect(referenceScale(1280, 720)).toBe(2 / 3);
  });

  it("fits the whole frame on a screen of another shape", () => {
    // 16:10: the width limits it.
    expect(referenceScale(1920, 1200)).toBe(1);
    // Ultra-wide: the height limits it.
    expect(referenceScale(3440, 1440)).toBe(1440 / 1080);
  });
});
