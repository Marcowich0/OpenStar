// The A/V offset (#161) at a frozen `songTime()`: everything drawn against
// Song time is drawn at `songTime() − A/V offset`, all by the same amount.
// The video is never in the draw list; `songTimeReaders.test.ts` checks that
// nothing but the drawing reads the offset.

import { describe, expect, it } from "vitest";

import type { DrawList, LyricEntry, PillEntry, PlayheadEntry } from "./frame";
import type { HeadBallEntry, PitchLineEntry } from "./pitchTrace";
import { laneLayout } from "./laneLayout";
import { createRenderLoop } from "./renderLoop";
import { syntheticSing } from "./syntheticSing";

/** Frozen Song time: Beat 10 of the synthetic Song (half a second per Beat). */
const SONG_TIME = 6;
/** +120 ms: the sound reaches the room 120 ms after the picture. */
const OFFSET = 0.12;
const lane = laneLayout(1)[0];
if (!lane) throw new Error("no lane");
/** 120 Beats a minute: two Beats a second. */
const pixelsPerSecond = lane.pixelsPerBeat * 2;

/** The draw list the render loop paints at a frozen `songTime()` and offset. */
function drawnAt(songTime: number, avOffset: number): DrawList {
  const state = syntheticSing("one");
  let list: DrawList = [];
  createRenderLoop({
    clock: () => ({ songTime: () => songTime }),
    avOffset: () => avOffset,
    state: () => state,
    paint: (painted) => {
      list = painted;
    },
    requestFrame: () => 0,
    cancelFrame: () => {},
  }).step();
  return list;
}

function only<T extends DrawList[number]["type"]>(list: DrawList, type: T) {
  return list.filter((e) => e.type === type) as Extract<
    DrawList[number],
    { type: T }
  >[];
}

describe("drawing with an A/V offset", () => {
  const still = drawnAt(SONG_TIME, 0);
  const shifted = drawnAt(SONG_TIME, OFFSET);

  it("moves every Note right by the offset's worth of scrolling", () => {
    const before = only(still, "pill");
    const after = only(shifted, "pill");
    const byStart = new Map<number, PillEntry>(
      after.map((p) => [p.note.start, p]),
    );
    const common = before.filter((p) => byStart.has(p.note.start));
    expect(common.length).toBeGreaterThan(3);
    for (const pill of common) {
      expect(byStart.get(pill.note.start)?.x).toBeCloseTo(
        pill.x + OFFSET * pixelsPerSecond,
        6,
      );
    }
  });

  it("keeps the playhead where it is, at the shifted Song time: the Note at Beat 10 starts just after it", () => {
    const [playhead] = only(shifted, "playhead") as PlayheadEntry[];
    expect(playhead?.x).toBe(only(still, "playhead")[0]?.x);
    // At 0 the Note at Beat 10 (6 s) starts on the playhead; 120 ms behind,
    // it is 120 ms of scrolling to the right of it.
    const onBeat10 = only(shifted, "pill").find((p) => p.note.start === 10);
    expect(onBeat10?.x).toBeCloseTo(
      (playhead?.x ?? 0) + OFFSET * pixelsPerSecond,
      6,
    );
    expect(only(still, "pill").find((p) => p.note.start === 10)?.x).toBe(
      playhead?.x,
    );
  });

  it("fills the lyric as at the shifted time", () => {
    // Beat 10 is a 2-Beat Note: at 6 s it has just started; at 5.88 s the
    // Note before it (Beats 6–9, golden) is still the current one, fully sung.
    const [atZero] = only(still, "lyric") as LyricEntry[];
    const [behind] = only(shifted, "lyric") as LyricEntry[];
    expect(atZero).toMatchObject({ note: 2, fraction: 0, singing: true });
    expect(behind).toMatchObject({ note: 1, fraction: 1, singing: false });

    // 0.62 s into a 1 s Note at 0, half of it at 120 ms behind.
    const later = (avOffset: number) =>
      drawnAt(6.62, avOffset).find(
        (e): e is LyricEntry => e.type === "lyric",
      );
    expect(later(0)?.fraction).toBeCloseTo(0.62, 6);
    expect(later(OFFSET)?.fraction).toBeCloseTo(0.5, 6);
  });

  it("holds the pitch trace to the playhead at the shifted time, and moves the rest with the Notes", () => {
    const line = (list: DrawList) =>
      (only(list, "pitchLine") as PitchLineEntry[]).flatMap((e) => e.points);
    const before = line(still);
    const after = line(shifted);
    const [playhead] = only(shifted, "playhead") as PlayheadEntry[];

    // The held part ends on the playhead, at Song time 6 − 0.12.
    const held = after.at(-1);
    expect(held?.guessed).toBe(true);
    expect(held?.x).toBeCloseTo(playhead?.x ?? 0, 6);
    expect(held?.songTime).toBeCloseTo(SONG_TIME - OFFSET, 9);
    expect(before.at(-1)?.songTime).toBeCloseTo(SONG_TIME, 9);

    // A sung point keeps its Song time and moves right with the Notes.
    const sung = before.filter((p) => !p.guessed);
    expect(sung.length).toBeGreaterThan(10);
    for (const point of sung) {
      const same = after.find(
        (p) => !p.guessed && p.songTime === point.songTime,
      );
      expect(same?.x).toBeCloseTo(point.x + OFFSET * pixelsPerSecond, 6);
    }

    const ball = (list: DrawList) =>
      (only(list, "headBall") as HeadBallEntry[])[0];
    expect(ball(shifted)?.x).toBeCloseTo(playhead?.x ?? 0, 6);
  });
});
