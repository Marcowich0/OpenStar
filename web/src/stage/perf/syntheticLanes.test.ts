import { describe, expect, it } from "vitest";

import type { PlacementClock } from "../../clock/placement";
import { frame } from "../sing/frame";
import { laneLayout, MAX_LANES } from "../sing/laneLayout";
import { syntheticSing } from "../sing/syntheticSing";
import { MAX_SYNTHETIC_LANES } from "../../stageSearch";
import {
  createSyntheticLanes,
  readingsRuns,
  type ReadingsRun,
} from "./syntheticLanes";

const files = import.meta.glob<string>(
  "../../../../fixtures/readings/run-*.json",
  { query: "?raw", import: "default", eager: true },
);

/** A Song clock that started at Stage time 0 and never pauses. */
const steadyClock: PlacementClock = {
  songTimeAt: (moment) => moment / 1000,
  playingAt: () => true,
  lastSeekAt: null,
};

/** A made-up run: one voiced reading every 10 ms for 2 s, Mic delay 100 ms. */
const shortRun: ReadingsRun = {
  kind: "singing",
  micDelayMs: 100,
  readings: Array.from({ length: 200 }, (_, i) => [i * 10, 62, 0.95, -20]),
};

function lanes(
  options: {
    count?: number;
    runs?: readonly ReadingsRun[];
    clock?: PlacementClock;
  } = {},
) {
  let now = 0;
  const synthetic = createSyntheticLanes({
    base: syntheticSing("duet"),
    count: options.count ?? 8,
    runs: options.runs ?? [shortRun],
    clock: options.clock ?? steadyClock,
    now: () => now,
  });
  return {
    synthetic,
    at: (ms: number) => {
      now = ms;
      synthetic.tick();
    },
  };
}

describe("the recorded readings", () => {
  it("reads every run, singing runs first", () => {
    const runs = readingsRuns(files);
    expect(runs).toHaveLength(11);
    expect(runs.slice(0, 5).map((run) => run.kind)).toEqual(
      Array(5).fill("singing"),
    );
    expect(runs[0]?.readings.length).toBeGreaterThan(1000);
  });
});

/** The singing runs: every lane draws a pitch line. */
const singing = readingsRuns(files).filter((run) => run.kind === "singing");

describe("synthetic lanes", () => {
  it("keeps the Song's background", () => {
    const synthetic = createSyntheticLanes({
      base: {
        ...syntheticSing("duet"),
        background: { kind: "blobs", still: false },
      },
      count: 8,
      runs: [shortRun],
      clock: steadyClock,
      now: () => 0,
    });
    expect(synthetic.state.background).toEqual({
      kind: "blobs",
      still: false,
    });
  });

  it("lays out at most as many lanes as the route accepts", () => {
    expect(MAX_SYNTHETIC_LANES).toBe(MAX_LANES);
  });

  it("takes the Song's Voices in turn, each lane with its own buffer", () => {
    const { synthetic } = lanes();
    const state = synthetic.state;
    expect(state.lanes.map((lane) => lane.voice)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1,
    ]);
    const buffers = new Set(state.lanes.map((lane) => lane.trace?.readings));
    expect(buffers.size).toBe(8);
    // Eight different Party colours.
    expect(new Set(state.lanes.map((lane) => lane.colour)).size).toBe(8);
  });

  it("replays a run's rows into each lane's buffer as their time comes", () => {
    const { synthetic, at } = lanes({ count: 1 });
    const buffer = synthetic.state.lanes[0]?.trace?.readings;
    at(495);
    // Rows at 0, 10, … 490 ms are due; each placed at (capture − delay).
    expect(buffer?.size).toBe(50);
    expect(buffer?.newestSongTime()).toBeCloseTo(0.39, 9);
    expect(buffer?.newestPitch()).toBe(62);
  });

  it("loops a run once it has played", () => {
    const { synthetic, at } = lanes({ count: 1 });
    const buffer = synthetic.state.lanes[0]?.trace?.readings;
    at(2500);
    expect(buffer?.newestSongTime()).toBeCloseTo(2.4, 3);
  });

  it("places nothing while the Song is paused", () => {
    const paused: PlacementClock = { ...steadyClock, playingAt: () => false };
    const { synthetic, at } = lanes({ count: 1, clock: paused });
    at(1000);
    expect(synthetic.state.lanes[0]?.trace?.readings.size).toBe(0);
  });

  it("starts a lane's buffer over when the Song restarts", () => {
    let restartAt = 0;
    const clock: PlacementClock = {
      songTimeAt: (moment) => (moment - restartAt) / 1000,
      playingAt: () => true,
      get lastSeekAt() {
        return restartAt === 0 ? null : restartAt;
      },
    };
    const { synthetic, at } = lanes({ count: 1, clock });
    const buffer = synthetic.state.lanes[0]?.trace?.readings;
    at(1500);
    restartAt = 1600;
    at(1800);
    // Only readings after the Restart, back near Song time 0.
    expect(buffer?.newestSongTime()).toBeCloseTo(0.1, 9);
    expect(buffer?.size).toBe(11);
  });

  it("pops Line ratings and throws Perfect! confetti as Lines end", () => {
    // The duet's first Lines end at 16.5 s (Beat 31) and 17 s (Beat 32).
    const { synthetic, at } = lanes({ runs: singing });
    const seen = new Set<string>();
    for (let ms = 0; ms <= 20000; ms += 100) {
      at(ms);
      // The render loop ages pops and particles by real time.
      synthetic.state.ratings?.advance(0.1);
      synthetic.state.particles?.advance(0.1);
      const list = frame(synthetic.state, ms / 1000, laneLayout(8));
      for (const entry of list) seen.add(entry.type);
    }
    expect(seen).toContain("lineRating");
    expect(seen).toContain("particle");
  });

  it("draws pitch lines from the replayed readings", () => {
    const { synthetic, at } = lanes({ runs: singing });
    for (let ms = 0; ms <= 8000; ms += 100) at(ms);
    const list = frame(synthetic.state, 7.5, laneLayout(8));
    const lanesWithLine = new Set(
      list.flatMap((entry) => (entry.type === "pitchLine" ? [entry.lane] : [])),
    );
    expect(lanesWithLine.size).toBe(8);
  });
});
