import { describe, expect, it } from "vitest";

import { createMatcher } from "../fit/fit";
import {
  fitCases,
  melody,
  melodySong,
  sungTrack,
  type FitCase,
} from "../fit/fitFixtures";
import { autoFit } from "./fitEdits";
import { commit, currentTiming, openTimingModel, undo } from "./timingModel";

const bpmError = fitCases.gapAndBpmError;
const oneLineLate = fitCases.oneLineLate;
const matcherFor = (c: FitCase) => createMatcher(sungTrack(c));

describe("Fit to the singing", () => {
  const model = openTimingModel(melodySong(bpmError));
  const matcher = matcherFor(bpmError);

  it("sets #GAP and #BPM from the fit search as one edit", () => {
    const fit = autoFit(model, matcher, { tempo: true });
    if (fit.kind !== "fitted") throw new Error("expected a fit");
    expect(fit.edit.operations.map((o) => o.op)).toEqual(["setGap", "setBpm"]);

    const after = currentTiming(commit(model, fit.edit, 0));
    expect(Math.abs(after.gapMs - 753)).toBeLessThanOrEqual(10);
    expect(Math.abs(after.bpm - 216.26)).toBeLessThanOrEqual(0.01);
    expect(fit.edit.description).toEqual({
      kind: "fitToTheSinging",
      fromGapMs: 3650,
      toGapMs: after.gapMs,
      fromBpm: 217.4,
      toBpm: after.bpm,
    });
    // One undo takes the whole fit back.
    expect(currentTiming(undo(commit(model, fit.edit, 0))).gapMs).toBe(3650);
  });

  it("describes the fit with the values before and after, and the shares", () => {
    const fit = autoFit(model, matcher, { tempo: true });
    if (fit.kind !== "fitted") throw new Error("expected a fit");
    const after = currentTiming(commit(model, fit.edit, 0));
    expect(fit.description.offset).toMatchObject({
      key: "fit.offsetEarlier",
      params: { seconds: 2.9, fromGap: 3650, toGap: after.gapMs },
    });
    expect(fit.description.tempo).toMatchObject({
      key: "fit.tempoSlower",
      params: { percent: 0.53, fromBpm: 217.4, toBpm: after.bpm },
    });
    const { from, to } = fit.description.share.params;
    expect(from).toBeLessThan(to);
    expect(to).toBe(Math.round((matcher.share(melody, after.grid) ?? 0) * 100));
  });

  it("offset only changes #GAP and keeps #BPM", () => {
    const fit = autoFit(model, matcher, { tempo: false });
    if (fit.kind !== "fitted") throw new Error("expected a fit");
    expect(fit.edit.operations.map((o) => o.op)).toEqual(["setGap"]);
    expect(fit.edit.description).toMatchObject({ kind: "fitOffsetOnly" });
    expect(fit.description.tempo).toBeNull();
    expect(currentTiming(commit(model, fit.edit, 0)).bpm).toBe(217.4);
  });

  it("is the best fit already when the search returns the current values", () => {
    const exact = openTimingModel(melodySong(fitCases.alreadyBest));
    expect(
      autoFit(exact, matcherFor(fitCases.alreadyBest), { tempo: true }),
    ).toEqual({
      kind: "alreadyBest",
      suggestions: [],
    });
  });

  it("lists the Lines still off after the fit", () => {
    const late = openTimingModel(melodySong(oneLineLate));
    const fit = autoFit(late, matcherFor(oneLineLate), { tempo: false });
    // Whether or not the fit moves the Song, Line 6 (index 5) stays 2 Beats late.
    expect(fit.suggestions.map(({ line, beats }) => ({ line, beats }))).toEqual(
      [{ line: 5, beats: 2 }],
    );
  });
});
