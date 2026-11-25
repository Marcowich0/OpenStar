import { describe, expect, it } from "vitest";

import { laneLayout } from "../stage/sing/laneLayout";
import { pitchBufferCapacity } from "./pitchCapacity";

// beatsPerMinute 240 → one Beat lasts 0.25 s.
const grid = { gapSeconds: 0, beatsPerMinute: 240 };

describe("Pitch buffer capacity", () => {
  it("covers one lane's drawable past and the A/V offset at 100 readings a second, doubled", () => {
    // One column: (600 − 320) / 44 Beats behind the playhead = 1.5909 s,
    // plus 1 s for the A/V offset = 2.5909 s → × 100 × 2 = 518.2 → 519.
    expect(pitchBufferCapacity(grid, laneLayout(1))).toBe(519);
  });

  it("follows the lane that shows the most past time", () => {
    // Two columns show 170 / 34 = 5 Beats, the one-column part is not used:
    // 5 × 0.25 + 1 = 2.25 s → 450.
    expect(pitchBufferCapacity(grid, laneLayout(6))).toBe(450);
  });

  it("grows for a slower Song", () => {
    const slow = { gapSeconds: 0, beatsPerMinute: 120 };
    // 6.3636 Beats × 0.5 s + 1 s = 4.1818 s → 836.4 → 837.
    expect(pitchBufferCapacity(slow, laneLayout(1))).toBe(837);
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
