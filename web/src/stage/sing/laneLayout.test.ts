import { describe, expect, it } from "vitest";

import { laneLayout } from "./laneLayout";

// Numbers from #55's sing screen layout, in the 1920 × 1080 reference frame.
describe("laneLayout", () => {
  it.each([
    [1, 170, [702]],
    [2, 140, [582, 732]],
    [3, 120, [492, 622, 752]],
    [4, 110, [402, 522, 642, 762]],
  ])(
    "stacks %i Player(s) in one column, %i px lanes, the lowest ending at y 872",
    (players, height, tops) => {
      const lanes = laneLayout(players);
      expect(lanes).toHaveLength(players);
      lanes.forEach((lane, i) => {
        expect(lane).toEqual({
          x: 60,
          y: tops[i],
          width: 1800,
          height,
          notesX: 320,
          playheadX: 600,
          pixelsPerBeat: 44,
        });
      });
      const last = lanes.at(-1);
      expect(last && last.y + last.height).toBe(872);
    },
  );

  it.each([5, 6, 7, 8])(
    "puts %i Players in two columns: Players 1 to 4 left, the rest right, row by row",
    (players) => {
      const lanes = laneLayout(players);
      expect(lanes).toHaveLength(players);
      const rowTops = [402, 522, 642, 762];
      lanes.forEach((lane, i) => {
        const columnX = i < 4 ? 60 : 970;
        expect(lane).toEqual({
          x: columnX,
          y: rowTops[i % 4],
          width: 890,
          height: 110,
          notesX: columnX + 210,
          playheadX: columnX + 380,
          pixelsPerBeat: 34,
        });
      });
      expect(Math.max(...lanes.map((l) => l.y + l.height))).toBe(872);
    },
  );

  it("follows the Player count, not the v1 seat count: 8 lanes for 8 Players", () => {
    expect(laneLayout(8)).toHaveLength(8);
  });

  it("has no lanes for no Players and refuses counts it has no design for", () => {
    expect(laneLayout(0)).toEqual([]);
    expect(() => laneLayout(9)).toThrow(RangeError);
    expect(() => laneLayout(2.5)).toThrow(RangeError);
  });
});
