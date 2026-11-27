import { describe, expect, it } from "vitest";

import { laneLayout } from "../stage/sing/laneLayout";
import { pitchBufferCapacity } from "./pitchCapacity";

// beatsPerMinute 240 → one Beat lasts 0.25 s.
const grid = { gapSeconds: 0, beatsPerMinute: 240 };

describe("Pitch buffer capacity", () => {
  it("covers one lane's drawable past and the A/V offset at 100 readings a second, doubled", () => {
    // One column: (600 − 320) px / 420 px/s behind the playhead = 0.6667 s,
    // plus 1 s for the A/V offset = 1.6667 s → × 100 × 2 = 333.3 → 334.
    expect(pitchBufferCapacity(grid, laneLayout(1))).toBe(334);
  });

  it("follows the lane that shows the most past time", () => {
    // Two columns show 170 px at 420 × 34 / 44 px/s = 0.5238 s, the
    // one-column part is not used: 0.5238 + 1 = 1.5238 s → 304.8 → 305.
    expect(pitchBufferCapacity(grid, laneLayout(6))).toBe(305);
  });

  it("draws the same past time whatever the BPM", () => {
    const slow = { gapSeconds: 0, beatsPerMinute: 120 };
    const fast = { gapSeconds: 0, beatsPerMinute: 1200 };
    expect(pitchBufferCapacity(slow, laneLayout(1))).toBe(334);
    expect(pitchBufferCapacity(fast, laneLayout(1))).toBe(334);
  });

  it("grows for a slower Note speed", () => {
    // 280 px / 315 px/s = 0.8889 s + 1 s = 1.8889 s → 377.8 → 378.
    expect(pitchBufferCapacity(grid, laneLayout(1, "slow"))).toBe(378);
  });

  it("still covers the scorer's unfinalised window with no lanes", () => {
    // One Beat (0.25 s) + 0.3 s grace + 0.3 s late delivery = 0.85 s → 170.
    expect(pitchBufferCapacity(grid, laneLayout(0))).toBe(170);
  });

  it("scales the scorer's window with the Beat length", () => {
    // One Beat lasts 6 s: 6 + 0.6 = 6.6 s → 1320.
    const glacial = { gapSeconds: 0, beatsPerMinute: 10 };
    expect(pitchBufferCapacity(glacial, laneLayout(0))).toBe(1320);
  });
});
