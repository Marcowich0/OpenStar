import { describe, expect, it } from "vitest";

import { resultsView } from "./resultsView";
import { playerResult } from "./testResults";

describe("the results screen's bars", () => {
  it("hatches the bar of a Player who did not finish, and shows no banner while another finished", () => {
    const view = resultsView([
      playerResult({ memberId: 1, total: 6000, newHighScore: true }),
      playerResult({ memberId: 2, total: 3000, unfinished: true }),
    ]);
    expect(view.endedEarly).toBe(false);
    expect(view.bars.map((bar) => bar.hatched)).toEqual([false, true]);
    expect(view.bars.map((bar) => bar.sticker)).toEqual([true, false]);
  });

  it("shows the banner when no Player finished, and never a sticker on an unfinished bar", () => {
    const view = resultsView([
      playerResult({
        memberId: 1,
        total: 4000,
        unfinished: true,
        newHighScore: true,
      }),
      playerResult({ memberId: 2, total: 2000, unfinished: true }),
    ]);
    expect(view.endedEarly).toBe(true);
    expect(view.bars.map((bar) => bar.hatched)).toEqual([true, true]);
    expect(view.bars.map((bar) => bar.sticker)).toEqual([false, false]);
  });

  it("makes each bar's height proportional to the total, at least 12 %", () => {
    const view = resultsView([
      playerResult({ memberId: 1, total: 10000 }),
      playerResult({ memberId: 2, total: 5000 }),
      playerResult({ memberId: 3, total: 600 }),
      playerResult({ memberId: 4, total: 0 }),
    ]);
    expect(view.bars.map((bar) => bar.height)).toEqual([1, 0.5, 0.12, 0.12]);
  });

  it("grows the bars 0.15 s apart and pops each sticker 0.9 s after its bar has grown", () => {
    const view = resultsView([
      playerResult({ memberId: 1, total: 9000, newHighScore: true }),
      playerResult({ memberId: 2, total: 8000, newHighScore: true }),
    ]);
    expect(view.bars.map((bar) => bar.growDelayMs)).toEqual([0, 150]);
    expect(view.bars.map((bar) => bar.stickerDelayMs)).toEqual([2000, 2150]);
  });

  it("stacks the three parts by their share of the total", () => {
    const [bar] = resultsView([
      playerResult({ total: 8000, notes: 6000, golden: 1200, lineBonus: 800 }),
    ]).bars;
    expect(bar?.parts).toEqual({ notes: 0.75, golden: 0.15, lineBonus: 0.1 });
  });

  it("keeps the server's ranking and places, equal totals sharing a place", () => {
    const view = resultsView([
      playerResult({ memberId: 3, total: 5000, place: 1 }),
      playerResult({ memberId: 1, total: 5000, place: 1 }),
      playerResult({ memberId: 2, total: 100, place: 3 }),
    ]);
    expect(
      view.bars.map((bar) => [bar.player.memberId, bar.player.place]),
    ).toEqual([
      [3, 1],
      [1, 1],
      [2, 3],
    ]);
  });
});
