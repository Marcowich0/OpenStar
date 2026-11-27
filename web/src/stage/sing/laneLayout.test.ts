import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTE_SPEED,
  laneLayout,
  NOTE_SPEED_LOOKAHEAD_SECONDS,
} from "./laneLayout";

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
          pixelsPerSecond: 420,
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
        expect(lane).toMatchObject({
          x: columnX,
          y: rowTops[i % 4],
          width: 890,
          height: 110,
          notesX: columnX + 210,
          playheadX: columnX + 380,
        });
        expect(lane.pixelsPerSecond).toBeCloseTo((420 * 34) / 44, 9);
      });
      expect(Math.max(...lanes.map((l) => l.y + l.height))).toBe(872);
    },
  );

  it("shows 3 s ahead of the playhead at the default Note speed, whatever the BPM", () => {
    expect(DEFAULT_NOTE_SPEED).toBe("normal");
    const [lane] = laneLayout(1);
    if (!lane) throw new Error("no lane");
    const ahead = lane.x + lane.width - lane.playheadX;
    expect(ahead / lane.pixelsPerSecond).toBeCloseTo(3, 9);
  });

  it.each(["slow", "normal", "fast"] as const)(
    "shows %s's lookahead on a one-column lane and about half of it on two columns",
    (speed) => {
      const seconds = NOTE_SPEED_LOOKAHEAD_SECONDS[speed];
      const [one] = laneLayout(1, speed);
      const [two] = laneLayout(8, speed);
      if (!one || !two) throw new Error("no lane");
      expect(
        (one.x + one.width - one.playheadX) / one.pixelsPerSecond,
      ).toBeCloseTo(seconds, 9);
      const twoAhead =
        (two.x + two.width - two.playheadX) / two.pixelsPerSecond;
      expect(twoAhead / seconds).toBeCloseTo(510 / 1260 / (34 / 44), 9);
    },
  );

  it("scrolls slower for a slower Note speed", () => {
    const px = (speed: "slow" | "normal" | "fast") =>
      laneLayout(1, speed)[0]?.pixelsPerSecond ?? 0;
    expect(px("slow")).toBeLessThan(px("normal"));
    expect(px("normal")).toBeLessThan(px("fast"));
  });

  it("follows the Player count, not the v1 seat count: 8 lanes for 8 Players", () => {
    expect(laneLayout(8)).toHaveLength(8);
  });

  it("has no lanes for no Players and refuses counts it has no design for", () => {
    expect(laneLayout(0)).toEqual([]);
    expect(() => laneLayout(9)).toThrow(RangeError);
    expect(() => laneLayout(2.5)).toThrow(RangeError);
  });
});
