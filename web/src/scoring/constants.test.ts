import { describe, expect, it } from "vitest";

import { SCORING, lineRatingWord, readingsNeeded } from "./constants";

// Expected values are the area spec's "Constants in one place" table (#54).
describe("scoring constants", () => {
  it("hold the spec's points, tolerances and limits", () => {
    expect(SCORING.notePoints).toBe(9000);
    expect(SCORING.lineBonusPoints).toBe(1000);
    expect(SCORING.linePerfectionMargin).toBe(2);
    expect(SCORING.lineRatingScale).toBe(8);
    expect(SCORING.toleranceCents).toEqual({
      easy: 250,
      medium: 150,
      hard: 50,
    });
    expect(SCORING.octaveFoldCents).toBe(600);
    expect(SCORING.voicedMinClarity).toBe(0.8);
    expect(SCORING.gracePeriodMs).toBe(300);
    expect(SCORING.micLostAfterMs).toBe(1000);
    expect(SCORING.rankTitleBandPoints).toBe(1250);
    expect(SCORING.rankTitleBands).toBe(8);
    expect(SCORING.highScoreTableLength).toBe(10);
  });

  it("need at least half of a Beat's readings, rounded up, minimum 1", () => {
    expect(readingsNeeded(0)).toBe(1);
    expect(readingsNeeded(1)).toBe(1);
    expect(readingsNeeded(2)).toBe(1);
    expect(readingsNeeded(3)).toBe(2);
    expect(readingsNeeded(4)).toBe(2);
    expect(readingsNeeded(5)).toBe(3);
  });

  it("map each Line rating to its word band", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(lineRatingWord)).toEqual([
      null,
      null,
      "ok",
      "ok",
      "good",
      "good",
      "great",
      "great",
      "perfect",
    ]);
  });
});
