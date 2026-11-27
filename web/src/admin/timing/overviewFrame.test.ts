import { describe, expect, it } from "vitest";

import { createMatcher } from "../../fit/fit";
import type { ParsedSong } from "../../generated/ParsedSong";
import { song as testSong } from "../../timing/testSong";
import {
  overviewFrame,
  overviewTimeAt,
  type OverviewInput,
} from "./overviewFrame";

// GAP 0 and one Beat 0.1 s. Line 0 of Voice 1 at 0–1 s, Line 1 at 4–5 s;
// Voice 2 has one Line at 2–3 s.
function duet(): ParsedSong {
  const base = testSong(1, { gapSeconds: 0, beatsPerMinute: 600 });
  const line = (start: number, line: number) => ({
    notes: [
      {
        kind: "normal" as const,
        start,
        length: 10,
        pitch: 0,
        text: "la",
        line,
      },
    ],
    end: null,
  });
  return {
    ...base,
    voices: [{ lines: [line(0, 1), line(40, 2)] }, { lines: [line(20, 4)] }],
  };
}

const C4 = 440 * 2 ** (-9 / 12);

/** 10 s of track; only Voice 1's first Line (0–1 s) is sung on its pitch. */
function track() {
  const pitch = new Float32Array(1000);
  const envelope = new Float32Array(1000);
  for (let i = 0; i < 100; i++) pitch[i] = C4;
  for (let i = 0; i < 1000; i++) envelope[i] = i < 500 ? 1 : 0.5;
  return {
    frameSeconds: 0.01,
    pitch,
    clarity: new Float32Array(1000),
    envelope,
  };
}

function input(ready: boolean): OverviewInput {
  const song = duet();
  const t = track();
  return {
    song,
    grid: song.headers,
    track: ready ? t : null,
    matcher: ready ? createMatcher(t) : null,
    duration: 10,
    playhead: 2.5,
    view: { start: 4, pixelsPerSecond: 100 },
    detailWidth: 200,
    width: 1000,
    height: 64,
  };
}

const bars = (ready: boolean) =>
  overviewFrame(input(ready)).filter((e) => e.type === "lineBar");

describe("the overview strip", () => {
  it("shows the whole Song: one bar per Line at its place", () => {
    expect(bars(true).map((b) => [b.voice, b.line, b.x, b.width])).toEqual([
      [0, 0, 0, 100],
      [0, 1, 400, 100],
      [1, 0, 200, 100],
    ]);
  });

  it("puts Voice 1 and Voice 2 on separate rows", () => {
    const [first, second, other] = bars(true);
    expect(first?.y).toBe(second?.y);
    expect(other?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0));
  });

  it("colours each bar by its Line's share, or as pending before the track", () => {
    expect(bars(true).map((b) => b.colour)).toEqual([
      { type: "share", share: 1 },
      { type: "share", share: 0 },
      { type: "share", share: 0 },
    ]);
    expect(bars(false).map((b) => b.colour.type)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("draws the waveform over the whole Song, the detail view's window and the playhead", () => {
    const list = overviewFrame(input(true));
    const wave = list.find((e) => e.type === "waveform");
    if (wave?.type !== "waveform") throw new Error("no waveform");
    expect(wave.heights).toHaveLength(1000);
    expect(wave.heights[100]).toBeCloseTo(wave.maxHeight, 9);
    expect(wave.heights[700]).toBeCloseTo(wave.maxHeight / 2, 6);
    expect(list.find((e) => e.type === "window")).toMatchObject({
      x: 400,
      width: 200,
    });
    expect(list.at(-1)).toMatchObject({ type: "playhead", x: 250 });
    expect(overviewFrame(input(false)).some((e) => e.type === "waveform")).toBe(
      false,
    );
  });

  it("turns a click into the Song time under it", () => {
    expect(overviewTimeAt(250, 1000, 10)).toBe(2.5);
    expect(overviewTimeAt(-5, 1000, 10)).toBe(0);
    expect(overviewTimeAt(1200, 1000, 10)).toBe(10);
  });
});
