import { describe, expect, it } from "vitest";

import { avatarFace } from "../../ui/avatarFace";
import { laneHeaderSizes } from "./laneHeader";
import { laneLayout } from "./laneLayout";

describe("laneHeaderSizes", () => {
  it("draws the avatar up to 70 px, never taller than the lane minus 14 px", () => {
    expect(laneHeaderSizes(170).avatar).toBe(70);
    expect(laneHeaderSizes(84).avatar).toBe(70);
    expect(laneHeaderSizes(80).avatar).toBe(66);
    expect(laneHeaderSizes(40).avatar).toBe(26);
  });

  it("sets the Score in 44 px, 36 px in lanes under 130 px, 28 px under 90 px", () => {
    expect(laneHeaderSizes(170).score).toBe(44);
    expect(laneHeaderSizes(130).score).toBe(44);
    expect(laneHeaderSizes(129).score).toBe(36);
    expect(laneHeaderSizes(90).score).toBe(36);
    expect(laneHeaderSizes(89).score).toBe(28);
  });

  it("shows the avatar's icon in every v1 layout, and the initial only in a lane too small for 32 px", () => {
    for (const players of [1, 2, 3, 4, 8]) {
      for (const lane of laneLayout(players)) {
        expect(avatarFace(laneHeaderSizes(lane.height).avatar)).toBe("icon");
      }
    }
    expect(avatarFace(laneHeaderSizes(44).avatar)).toBe("initial");
  });
});
