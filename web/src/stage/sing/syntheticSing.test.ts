import { describe, expect, it } from "vitest";

import { SING_TEST_CASES } from "../../singTest/search";
import { frame } from "./frame";
import { laneLayout } from "./laneLayout";
import { syntheticSing } from "./syntheticSing";

describe("syntheticSing", () => {
  it.each([
    ["one", 1, [0]],
    ["four", 4, [0, 0, 0, 0]],
    ["eight", 8, [0, 0, 0, 0, 0, 0, 0, 0]],
    ["duet", 2, [0, 1]],
  ] as const)(
    "case %s has %i lanes singing Voices %j",
    (name, lanes, voices) => {
      const state = syntheticSing(name);
      expect(state.lanes.map((l) => l.voice)).toEqual(voices);
      expect(state.lanes).toHaveLength(lanes);
      expect(new Set(state.lanes.map((l) => l.colour)).size).toBe(lanes);
    },
  );

  it("covers every case the test entry accepts", () => {
    for (const name of SING_TEST_CASES)
      expect(syntheticSing(name).lanes.length).toBeGreaterThan(0);
  });

  it("shows every Note kind, a passed Note and a Note on the playhead at the default time", () => {
    const state = syntheticSing("one");
    const pills = frame(state, 6, laneLayout(1)).filter(
      (e) => e.type === "pill",
    );
    expect(new Set(pills.map((p) => p.kind))).toEqual(
      new Set(["normal", "golden", "rap", "goldenRap", "freestyle"]),
    );
    expect(pills.some((p) => p.passed)).toBe(true);
    expect(pills.some((p) => p.x === 600)).toBe(true);
  });

  it("shows a golden star and a shimmer in the one-Player case at the default time", () => {
    const pills = frame(syntheticSing("one"), 6, laneLayout(1)).filter(
      (e) => e.type === "pill",
    );
    expect(pills.some((p) => p.star !== null)).toBe(true);
    // A band part-way across its pill, so the screenshot shows it.
    expect(
      pills.some(
        (p) =>
          p.shimmer !== null &&
          p.shimmer.x > p.x &&
          p.shimmer.x + p.shimmer.width < p.x + p.width,
      ),
    ).toBe(true);
  });

  it("names a made-up Player in every lane, one of them a Guest, with a running Score", () => {
    for (const name of SING_TEST_CASES) {
      const lanes = syntheticSing(name).lanes;
      for (const lane of lanes) {
        expect(lane.player?.name).toBeTruthy();
        expect(lane.player?.score).toBeGreaterThanOrEqual(0);
      }
      if (lanes.length > 1) {
        expect(lanes.filter((l) => l.player?.guest)).toHaveLength(1);
      }
    }
  });

  it("uses placeholder lyrics only", () => {
    for (const voice of syntheticSing("duet").voices) {
      for (const note of voice.notes) expect(note.text.trim()).toBe("la");
    }
  });

  it("gives every lane a pitch line held to the playhead, with hits, misses and a head ball, at the default time", () => {
    const list = frame(syntheticSing("one"), 6, laneLayout(1));
    const points = list.flatMap((e) =>
      e.type === "pitchLine" ? e.points : [],
    );
    expect(points.some((p) => p.hit)).toBe(true);
    expect(points.some((p) => !p.hit)).toBe(true);
    expect(points.some((p) => p.guessed)).toBe(true);
    expect(points.at(-1)?.x).toBe(600);
    // An unvoiced stretch breaks the line.
    expect(list.filter((e) => e.type === "pitchLine").length).toBeGreaterThan(
      1,
    );
    expect(list.filter((e) => e.type === "headBall")).toHaveLength(1);
  });

  it("shows a lost lane in the four-Player case", () => {
    const list = frame(syntheticSing("four"), 6, laneLayout(4));
    const lanes = list.filter((e) => e.type === "lane");
    expect(lanes.map((l) => l.lost !== null)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(list.filter((e) => e.type === "headBall")).toHaveLength(3);
  });
});
