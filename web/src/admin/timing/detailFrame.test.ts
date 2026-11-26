import { describe, expect, it } from "vitest";

import { createMatcher } from "../../fit/fit";
import type { PitchTrack } from "../../fit/pitchTrackFile";
import type { Note } from "../../generated/Note";
import type { NoteKind } from "../../generated/NoteKind";
import type { ParsedSong } from "../../generated/ParsedSong";
import { song as testSong } from "../../timing/testSong";
import {
  detailFrame,
  hitDetail,
  type DetailEntry,
  type DetailInput,
  type PillEntry,
} from "./detailFrame";

// A small Song on a simple grid: GAP 0, #BPM 150, so one Beat is 0.1 s, and a
// view of 100 px per second, so one Beat is 10 px.
const KINDS: [NoteKind, number, number, number][] = [
  // kind, start Beat, length, pitch
  ["normal", 0, 10, 0],
  ["golden", 10, 10, 4],
  ["rap", 20, 5, 9],
  ["goldenRap", 25, 5, 9],
  ["freestyle", 30, 10, 2],
];

function fixtureSong(): ParsedSong {
  const base = testSong(1, { gapSeconds: 0, beatsPerMinute: 600 });
  const notes: Note[] = KINDS.map(([kind, start, length, pitch], i) => ({
    kind,
    start,
    length,
    pitch,
    text: ` la${String(i)} `,
    line: 10 + i,
  }));
  return { ...base, voices: [{ lines: [{ notes, end: null }] }] };
}

const C4 = 440 * 2 ** (-9 / 12);
const E4 = 440 * 2 ** (-5 / 12);

/**
 * 4 s of track: the Normal note (0–1 s) sung on its pitch for its first half
 * only, the Golden note (1–2 s) sung on its pitch throughout, the rest silent.
 */
function fixtureTrack(): PitchTrack {
  const frames = 400;
  const pitch = new Float32Array(frames);
  const envelope = new Float32Array(frames);
  for (let i = 0; i < 50; i++) pitch[i] = C4;
  for (let i = 100; i < 200; i++) pitch[i] = E4;
  for (let i = 0; i < frames; i++) envelope[i] = i < 200 ? 0.5 : 0.1;
  return {
    frameSeconds: 0.01,
    pitch,
    clarity: new Float32Array(frames),
    envelope,
  };
}

function input(track: PitchTrack | null): DetailInput {
  const song = fixtureSong();
  return {
    song,
    grid: song.headers,
    track,
    matcher: track ? createMatcher(track) : null,
    playhead: 1.5,
    view: { start: 0, pixelsPerSecond: 100 },
    width: 500,
    height: 300,
  };
}

const pills = (list: DetailEntry[]) =>
  list.filter((e): e is PillEntry => e.type === "pill");

describe("the detail view's draw list", () => {
  const list = detailFrame(input(fixtureTrack()));

  it("draws every Note as a pill at its time, styled per kind", () => {
    const drawn = pills(list);
    expect(drawn.map((p) => p.kind)).toEqual(KINDS.map(([kind]) => kind));
    expect(drawn.map((p) => [p.x, p.width])).toEqual([
      [0, 100],
      [100, 100],
      [200, 50],
      [250, 50],
      [300, 100],
    ]);

    const [normal, golden, rap, goldenRap, freestyle] = drawn;
    expect(normal).toMatchObject({ fill: "white", dashed: false });
    expect(golden).toMatchObject({ fill: "golden", dashed: false });
    expect(rap).toMatchObject({ fill: "white", dashed: true });
    expect(goldenRap).toMatchObject({ fill: "golden", dashed: true });
    expect(freestyle).toMatchObject({ fill: null, dashed: false });
  });

  it("puts the lyric under each pill, italic on Rap, Golden rap and Freestyle notes", () => {
    const drawn = pills(list);
    expect(drawn.map((p) => p.lyric.text)).toEqual([
      "la0",
      "la1",
      "la2",
      "la3",
      "la4",
    ]);
    expect(drawn.map((p) => p.lyric.italic)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    for (const p of drawn) {
      expect(p.lyric.x).toBe(p.x);
      expect(p.lyric.y).toBeGreaterThan(p.y + p.height);
    }
  });

  it("draws Notes higher for a higher pitch, and Rap notes at mid-height", () => {
    const [normal, golden, rap, goldenRap, freestyle] = pills(list).map(
      (p) => p.y + p.height / 2,
    );
    expect(golden).toBeLessThan(freestyle ?? 0);
    expect(freestyle).toBeLessThan(normal ?? 0);
    // The pitch range is −2 … 6 (Notes 0, 4, 2 with a 2-semitone margin):
    // mid-height is pitch 2, the Freestyle note's row.
    expect(rap).toBeCloseTo(freestyle ?? 0, 9);
    expect(goldenRap).toBeCloseTo(freestyle ?? 0, 9);
  });

  it("fills each Normal and Golden note green from the left by its match share", () => {
    const drawn = pills(list);
    expect(drawn.map((p) => p.match)).toEqual([
      { share: 0.5, width: 50 },
      { share: 1, width: 100 },
      null,
      null,
      null,
    ]);
  });

  it("draws one dot per voiced frame of the heard pitch, on the Notes' rows", () => {
    const dots = list.find((e) => e.type === "dots");
    expect(dots?.type).toBe("dots");
    if (dots?.type !== "dots") return;
    expect(dots.points.length).toBe(2 * 150);
    const [normal, golden] = pills(list);
    // The first dot is the Normal note's C, at that pill's centre row.
    expect(dots.points[0]).toBe(0);
    expect(dots.points[1]).toBeCloseTo(
      (normal?.y ?? 0) + (normal?.height ?? 0) / 2,
      3,
    );
    expect(dots.points[2 * 100 + 1]).toBeCloseTo(
      (golden?.y ?? 0) + (golden?.height ?? 0) / 2,
      3,
    );
  });

  it("draws the waveform from the RMS envelope, one column per pixel", () => {
    const wave = list.find((e) => e.type === "waveform");
    if (wave?.type !== "waveform") throw new Error("no waveform");
    expect(wave.heights).toHaveLength(500);
    // The envelope is loudest (0.5) for the first 2 s, 0.1 after: scaled to
    // the loudest frame, then to half the waveform band.
    expect(wave.heights[50]).toBeCloseTo(wave.halfHeight, 9);
    expect(wave.heights[250]).toBeCloseTo(wave.halfHeight / 5, 6);
    expect(wave.heights[450]).toBe(0);
  });

  it("draws the playhead at its Song time", () => {
    expect(list.at(-1)).toMatchObject({ type: "playhead", x: 150 });
  });

  it("colours the Line's bar by its share", () => {
    const bar = list.find((e) => e.type === "lineBar");
    // Frames: 50 of 100 on the Normal note, 100 of 100 on the Golden one.
    expect(bar).toMatchObject({ colour: { type: "share", share: 0.75 } });
  });
});

describe("where the heard pitch is drawn", () => {
  /** One Note at `pitch` over 0–1 s, and a track singing `hz` over it. */
  function dotsFor(pitches: number[], hz: number) {
    const base = fixtureSong();
    const notes = pitches.map((pitch, i) => ({
      kind: "normal" as const,
      start: 10 * i,
      length: 10,
      pitch,
      text: "la",
      line: 10 + i,
    }));
    const song = { ...base, voices: [{ lines: [{ notes, end: null }] }] };
    const track = fixtureTrack();
    track.pitch.fill(0);
    track.pitch.fill(hz, 0, 100);
    const list = detailFrame({ ...input(track), song });
    const dots = list.find((e) => e.type === "dots");
    if (dots?.type !== "dots") throw new Error("no dots");
    return { dots: dots.points, pills: pills(list) };
  }
  const centreOf = (p: PillEntry | undefined) =>
    (p?.y ?? 0) + (p?.height ?? 0) / 2;

  it("keeps a heard pitch inside the Notes' range where it is", () => {
    // Notes on C4 and C5: a heard C5 stays on the C5 Note's row.
    const { dots, pills: drawn } = dotsFor([0, 12], 2 * C4);
    expect(dots[1]).toBeCloseTo(centreOf(drawn[1]), 3);
  });

  it("folds a heard pitch outside the Notes' range into it by octaves", () => {
    // Notes on C4 and E4 only: a heard C6 is drawn on the C4 row.
    const { dots, pills: drawn } = dotsFor([0, 4], 4 * C4);
    expect(dots[1]).toBeCloseTo(centreOf(drawn[0]), 3);
  });
});

describe("the detail view before the Pitch track is ready", () => {
  const list = detailFrame(input(null));

  it("draws the Notes, the Line and the playhead, but no dots, waveform or green fill", () => {
    expect(pills(list)).toHaveLength(5);
    expect(pills(list).every((p) => p.match === null)).toBe(true);
    expect(list.some((e) => e.type === "dots")).toBe(false);
    expect(list.some((e) => e.type === "waveform")).toBe(false);
    expect(list.find((e) => e.type === "lineBar")).toMatchObject({
      colour: { type: "pending" },
    });
    expect(list.at(-1)).toMatchObject({ type: "playhead" });
  });
});

describe("what the detail view leaves out", () => {
  it("skips Notes outside the view", () => {
    const list = detailFrame({
      ...input(fixtureTrack()),
      view: { start: 1.6, pixelsPerSecond: 100 },
      width: 100,
    });
    expect(pills(list).map((p) => p.kind)).toEqual([
      "golden",
      "rap",
      "goldenRap",
    ]);
  });

  it("marks every second on the ruler and labels every fifth", () => {
    const list = detailFrame({
      ...input(null),
      view: { start: 58, pixelsPerSecond: 100 },
      width: 1000,
    });
    const ruler = list.find((e) => e.type === "ruler");
    if (ruler?.type !== "ruler") throw new Error("no ruler");
    expect(ruler.ticks.map((tick) => tick.x)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => 200 + s * 100 - 200),
    );
    expect(ruler.labels).toEqual([
      { x: 200, text: "1:00" },
      { x: 700, text: "1:05" },
    ]);
  });
});

describe("the selection, the pin and the ◀▶ handle", () => {
  // Two Lines: Notes at 0–1 s and 1–2 s, then 3–4 s.
  function twoLines(): DetailInput {
    const base = input(null);
    const note = (start: number, line: number): Note => ({
      kind: "normal",
      start,
      length: 10,
      pitch: 0,
      text: "la",
      line,
    });
    const song: ParsedSong = {
      ...base.song,
      voices: [
        {
          lines: [
            { notes: [note(0, 10), note(10, 11)], end: { beat: 25, line: 12 } },
            { notes: [note(30, 13)], end: null },
          ],
        },
      ],
    };
    return { ...base, song, grid: song.headers };
  }
  const bands = (list: DetailEntry[]) =>
    list.filter((e) => e.type === "lineBand").map((e) => e.colour);

  it("tints the selected Lines and the pinned Line, and puts the handle at the selection's end", () => {
    const list = detailFrame({
      ...twoLines(),
      selection: { voice: 0, anchor: 0, first: 0, last: 0 },
      pin: { voice: 0, line: 1 },
    });
    expect(bands(list)).toEqual(["--color-blue", "--color-purple"]);
    const handle = list.find((e) => e.type === "handle");
    // The selection ends at 2 s: 200 px.
    expect(handle).toMatchObject({ x: 202, text: "◀▶" });
    expect(list.filter((e) => e.type === "pin")).toMatchObject([{ x: 300 }]);
  });

  it("draws neither without a selection or a pin", () => {
    const list = detailFrame(twoLines());
    expect(bands(list)).toEqual(["--color-ink", "--color-ink"]);
    expect(list.some((e) => e.type === "handle" || e.type === "pin")).toBe(
      false,
    );
  });
});

describe("what the pointer is on", () => {
  const at = (x: number, y: number, extra: Partial<DetailInput> = {}) =>
    hitDetail({ ...input(null), ...extra }, x, y);
  // The Normal note (pitch 0) sits 0–100 px; find its row from the frame.
  const normal = pills(detailFrame(input(null)))[0];
  const y = (normal?.y ?? 0) + (normal?.height ?? 0) / 2;

  it("is the ruler above the Notes area", () => {
    expect(at(50, 5)).toEqual({ kind: "ruler" });
  });

  it("is a Note on its pill, and its right end in the last 6 px", () => {
    expect(at(50, y)).toEqual({
      kind: "note",
      voice: 0,
      line: 0,
      note: 0,
      edge: false,
    });
    expect(at(97, y)).toMatchObject({ kind: "note", note: 0, edge: true });
  });

  it("is the Line beside a Note, and empty space away from every Line", () => {
    // Below the Notes, the time alone picks the Line (0–4 s).
    expect(at(150, 290)).toEqual({ kind: "line", voice: 0, line: 0 });
    expect(at(480, y)).toEqual({ kind: "empty" });
  });

  it("is the handle where it is drawn", () => {
    const selection = { voice: 0, anchor: 0, first: 0, last: 0 };
    // The Line ends at 4 s: the handle is at 402–418 px, just below the ruler.
    expect(at(408, 34, { selection })).toEqual({ kind: "handle" });
    expect(at(408, 34)).toEqual({ kind: "empty" });
  });
});
