// The Check A/V sync test pattern as a draw list (#163): a ball bouncing on a
// lane line once a second, touching it at each click's landing time on the
// shifted clock (landing time − A/V offset).

import { describe, expect, it } from "vitest";

import type { DrawList, GridEntry, HeadBallEntry } from "../stage/sing/frame";
import { avSyncFrame } from "./avSyncFrame";

const LANDINGS = [10_000, 11_000, 12_000];

function ball(list: DrawList): HeadBallEntry {
  const found = list.find((entry) => entry.type === "headBall");
  if (!found) throw new Error("no ball");
  return found;
}

function laneLine(list: DrawList): number {
  const grid = list.find((entry): entry is GridEntry => entry.type === "grid");
  const y = grid?.ys[0];
  if (y === undefined) throw new Error("no lane line");
  return y;
}

/** How far the ball's bottom is above the lane line, px. */
function height(landings: readonly number[], nowMs: number, offsetMs: number) {
  const list = avSyncFrame(landings, nowMs, offsetMs);
  const { y, radius } = ball(list);
  return laneLine(list) - (y + radius);
}

describe("the Check A/V sync draw list", () => {
  it("draws one lane with its line and the ball, inside the lane's clip", () => {
    const types = avSyncFrame(LANDINGS, 10_500, 0).map((entry) => entry.type);
    expect(types).toEqual(["lane", "grid", "headBall", "laneEnd"]);
  });

  it("at offset 0, touches the lane line at each landing time", () => {
    for (const landing of LANDINGS) {
      expect(height(LANDINGS, landing, 0)).toBeCloseTo(0, 6);
    }
  });

  it("is in the air between landings, highest halfway", () => {
    const quarter = height(LANDINGS, 10_250, 0);
    const half = height(LANDINGS, 10_500, 0);
    expect(quarter).toBeGreaterThan(50);
    expect(half).toBeGreaterThan(quarter);
    expect(height(LANDINGS, 10_750, 0)).toBeCloseTo(quarter, 6);
  });

  it("at +120 ms, touches the line 120 ms after each landing time", () => {
    expect(height(LANDINGS, 11_000, 120)).toBeGreaterThan(10);
    expect(height(LANDINGS, 11_120, 120)).toBeCloseTo(0, 6);
    expect(height(LANDINGS, 12_120, 120)).toBeCloseTo(0, 6);
  });

  it("at −300 ms, touches the line 300 ms before each landing time", () => {
    expect(height(LANDINGS, 10_700, -300)).toBeCloseTo(0, 6);
  });

  it("keeps bouncing once a second before the first and after the last landing", () => {
    expect(height(LANDINGS, 9_000, 0)).toBeCloseTo(0, 6);
    expect(height(LANDINGS, 9_500, 0)).toBeCloseTo(height(LANDINGS, 10_500, 0));
    expect(height(LANDINGS, 13_000, 0)).toBeCloseTo(0, 6);
  });

  it("rests on the line while no click has been scheduled yet", () => {
    expect(height([], 5_000, 0)).toBeCloseTo(0, 6);
    expect(height([], 5_500, 120)).toBeCloseTo(0, 6);
  });
});
