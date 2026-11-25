import { describe, expect, it } from "vitest";

import { SING_TEST_CASES } from "../../singTestSearch";
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

  it("uses placeholder lyrics only", () => {
    for (const voice of syntheticSing("duet").voices) {
      for (const note of voice.notes) expect(note.text.trim()).toBe("la");
    }
  });
});
