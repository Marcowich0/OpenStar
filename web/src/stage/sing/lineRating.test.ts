import { describe, expect, it } from "vitest";

import type { LineResult } from "../../scoring/scorer";
import type { ParticleEntry } from "./effects";
import { ParticlePool } from "./effects";
import { frame, singVoices, type DrawEntry, type SingState } from "./frame";
import { laneLayout } from "./laneLayout";
import {
  LINE_RATING_SECONDS,
  lineEnded,
  LineRatings,
  lineRatingPop,
  type LineRatingEntry,
} from "./lineRating";

const grid = { gapSeconds: 1, beatsPerMinute: 120 };

function state(players: number, extra: Partial<SingState> = {}): SingState {
  return {
    grid,
    voices: singVoices({
      voices: [
        {
          lines: [
            {
              notes: [
                {
                  kind: "normal",
                  start: 4,
                  length: 2,
                  pitch: 0,
                  text: "la ",
                  line: 1,
                },
              ],
              end: null,
            },
          ],
        },
      ],
    }),
    lanes: Array.from({ length: players }, (_, i) => ({
      colour: i === 0 ? ("cherry" as const) : ("sky" as const),
      voice: 0,
    })),
    ...extra,
  };
}

function ratings(list: readonly DrawEntry[]): LineRatingEntry[] {
  return list.filter((e): e is LineRatingEntry => e.type === "lineRating");
}

function particles(list: readonly DrawEntry[]): ParticleEntry[] {
  return list.filter((e): e is ParticleEntry => e.type === "particle");
}

function result(rating: number): LineResult {
  const words = [
    null,
    null,
    "ok",
    "ok",
    "good",
    "good",
    "great",
    "great",
    "perfect",
  ] as const;
  const word = words[rating] ?? null;
  return {
    lineIndex: 0,
    linePoints: 0,
    lineMax: 0,
    linePerfection: rating / 8,
    bonus: 0,
    rating,
    word: word === null ? null : `sing.lineRating.${word}`,
  };
}

describe("the Line rating pop", () => {
  it("lasts about 1.3 s", () => {
    expect(LINE_RATING_SECONDS).toBeCloseTo(1.3);
    expect(lineRatingPop(-0.01)).toBeNull();
    expect(lineRatingPop(1.31)).toBeNull();
    expect(lineRatingPop(0)).not.toBeNull();
  });

  it("grows from 30 % to 120 % in the first fifth, then settles at 100 %", () => {
    expect(lineRatingPop(0)?.scale).toBeCloseTo(0.3);
    expect(lineRatingPop(0.26)?.scale).toBeCloseTo(1.2);
    expect(lineRatingPop(0.5)?.scale).toBeCloseTo(1);
    expect(lineRatingPop(0.8)?.scale).toBeCloseTo(1);
    // It grows the whole first fifth.
    const early = lineRatingPop(0.1)?.scale ?? 0;
    expect(early).toBeGreaterThan(0.3);
    expect(early).toBeLessThan(1.2);
  });

  it("fades out at the end while rising slightly", () => {
    const settled = lineRatingPop(0.6);
    expect(settled?.alpha).toBe(1);
    expect(settled?.rise).toBe(0);
    const late = lineRatingPop(1.25);
    expect(late?.alpha).toBeLessThan(0.3);
    expect(late?.rise).toBeGreaterThan(0);
    expect(late?.rise).toBeLessThan(30);
  });
});

describe("Line ratings in the draw list", () => {
  it("pops the word about 110 px right of the lane header, vertically centred, in the Party colour", () => {
    const s = state(2, { ratings: new LineRatings() });
    lineEnded(s, 1, result(6));
    const layout = laneLayout(2);
    const [entry] = ratings(frame(s, 2, layout));
    const rect = layout[1];
    expect(entry).toMatchObject({
      lane: 1,
      word: "sing.lineRating.great",
      colour: "sky",
      x: (rect?.notesX ?? 0) + 110,
      y: (rect?.y ?? 0) + (rect?.height ?? 0) / 2,
      size: 40,
    });
  });

  it("is 30 px in lanes under 90 px", () => {
    const s = state(1, { ratings: new LineRatings() });
    lineEnded(s, 0, result(8));
    // No layout has lanes this low yet; the rule holds for any lane.
    const [one] = laneLayout(1);
    const low = one ? [{ ...one, height: 89 }] : [];
    expect(ratings(frame(s, 2, low))[0]?.size).toBe(30);
    const tall = one ? [{ ...one, height: 90 }] : [];
    expect(ratings(frame(s, 2, tall))[0]?.size).toBe(40);
  });

  it("moves on real time and is gone after the pop", () => {
    const pops = new LineRatings();
    const s = state(1, { ratings: pops });
    lineEnded(s, 0, result(4));
    const layout = laneLayout(1);
    expect(ratings(frame(s, 2, layout))[0]?.scale).toBeCloseTo(0.3);
    pops.advance(0.26);
    expect(ratings(frame(s, 2, layout))[0]?.scale).toBeCloseTo(1.2, 1);
    // A long frame moves it by `MAX_FRAME_DELTA` at most.
    pops.advance(5);
    expect(ratings(frame(s, 2, layout))).toHaveLength(1);
    for (let i = 0; i < 4; i++) pops.advance(0.25);
    expect(ratings(frame(s, 2, layout))).toEqual([]);
  });

  it("shows nothing when the rating has no word", () => {
    const s = state(1, { ratings: new LineRatings() });
    lineEnded(s, 0, result(1));
    lineEnded(s, 0, result(0));
    expect(ratings(frame(s, 2, laneLayout(1)))).toEqual([]);
  });

  it("a newer Line's rating replaces the one still showing", () => {
    const pops = new LineRatings();
    const s = state(1, { ratings: pops });
    lineEnded(s, 0, result(2));
    pops.advance(0.7);
    lineEnded(s, 0, result(6));
    const shown = ratings(frame(s, 2, laneLayout(1)));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ word: "sing.lineRating.great" });
    expect(shown[0]?.scale).toBeCloseTo(0.3);
  });

  it("clear() drops every pop (a Restart)", () => {
    const pops = new LineRatings();
    const s = state(1, { ratings: pops });
    lineEnded(s, 0, result(8));
    pops.clear();
    expect(ratings(frame(s, 2, laneLayout(1)))).toEqual([]);
  });
});

describe("a Perfect! Line", () => {
  it("bursts about 30 particles at the lane header, in the Player's colour and the accents", () => {
    const pool = new ParticlePool(512, { seed: 7 });
    const s = state(2, { ratings: new LineRatings(), effects: pool });
    lineEnded(s, 1, result(8));
    expect(pool.live).toBe(30);
    const layout = laneLayout(2);
    const rect = layout[1];
    const list = frame(s, 2, layout);
    const ps = particles(list);
    // Not moved yet: all at the header's centre.
    for (const p of ps) {
      expect(p.x).toBeCloseTo(((rect?.x ?? 0) + (rect?.notesX ?? 0)) / 2);
      expect(p.y).toBeCloseTo((rect?.y ?? 0) + (rect?.height ?? 0) / 2);
    }
    expect(ps.some((p) => p.colour === "sky")).toBe(true);
    expect(ps.some((p) => p.colour !== "sky")).toBe(true);
  });

  it("only Perfect! bursts", () => {
    const pool = new ParticlePool(512);
    const s = state(1, { ratings: new LineRatings(), effects: pool });
    lineEnded(s, 0, result(7));
    expect(pool.live).toBe(0);
  });
});
