import { describe, expect, it } from "vitest";

import { must, song } from "../timing/testSong";
import {
  describeFit,
  describeLineSuggestion,
  fitText,
  lineSuggestionText,
} from "./describeFit";

// The real case the spec names: GAP 3650 → 753 ms, BPM 217.4 → 216.26,
// notes on the singing 15 % → 62 %.
const vincent = {
  from: { gapMs: 3650, bpm: 217.4, share: 0.15 },
  to: { gapMs: 753, bpm: 216.26, share: 0.62 },
};

describe("describing a fit in plain words", () => {
  it("gives the offset, the tempo change and the shares as text keys and parameters", () => {
    expect(describeFit(vincent.from, vincent.to)).toEqual({
      kind: "fitted",
      offset: {
        key: "fit.offsetEarlier",
        params: { seconds: 2.9, fromGap: 3650, toGap: 753 },
      },
      tempo: {
        key: "fit.tempoSlower",
        params: { percent: 0.53, fromBpm: 217.4, toBpm: 216.26 },
      },
      share: { key: "fit.share", params: { from: 15, to: 62 } },
    });
  });

  it("reads as the spec's example", () => {
    expect(fitText(describeFit(vincent.from, vincent.to))).toEqual([
      "notes 2.9 s earlier (GAP 3,650 → 753 ms), tempo 0.53 % slower (BPM 217.4 → 216.26)",
      "Notes on the singing 15 % → 62 %.",
    ]);
  });

  it("says later and faster the other way round", () => {
    const d = describeFit(
      { gapMs: 753, bpm: 216.26, share: 0.2 },
      { gapMs: 1253, bpm: 220, share: 0.5 },
    );
    expect(fitText(d)[0]).toBe(
      // (216.26 / 220 − 1) × 100 = −1.70 %: faster.
      "notes 0.5 s later (GAP 753 → 1,253 ms), tempo 1.7 % faster (BPM 216.26 → 220)",
    );
  });

  it("names only the offset when #BPM stays (offset only)", () => {
    const d = describeFit(
      { gapMs: 3650, bpm: 217.4, share: 0.15 },
      { gapMs: 3604, bpm: 217.4, share: 0.31 },
    );
    expect(d).toMatchObject({ kind: "fitted", tempo: null });
    expect(fitText(d)).toEqual([
      "notes 0.05 s earlier (GAP 3,650 → 3,604 ms)",
      "Notes on the singing 15 % → 31 %.",
    ]);
  });

  it("names only the tempo when #GAP stays", () => {
    const d = describeFit(
      { gapMs: 100, bpm: 200, share: 0.4 },
      { gapMs: 100, bpm: 201, share: 0.6 },
    );
    expect(fitText(d)[0]).toBe("tempo 0.5 % faster (BPM 200 → 201)");
  });

  it("is the best fit already when the values are the current ones", () => {
    const d = describeFit(vincent.from, { ...vincent.from });
    expect(d).toEqual({ kind: "alreadyBest" });
    expect(fitText(d)).toEqual(["Already the best fit the editor can find."]);
  });
});

describe("describing a Line still off", () => {
  const starry = song(14);
  const line = must(starry.voices[0]?.lines[11]);
  line.notes[0] = { ...must(line.notes[0]), text: "Starry, " };
  line.notes[1] = { ...must(line.notes[1]), text: "starry night, paint" };

  it("gives the Line number, the start of its lyric, the Beats and the shares", () => {
    const suggestion = {
      voice: 0,
      line: 11,
      beats: 2,
      shareBefore: 0.31,
      shareAfter: 0.74,
    };
    expect(describeLineSuggestion(suggestion, starry)).toEqual({
      key: "fit.lineLater",
      params: {
        line: 12,
        lyric: "Starry, starry…",
        count: 2,
        from: 31,
        to: 74,
      },
    });
    expect(lineSuggestionText(describeLineSuggestion(suggestion, starry))).toBe(
      "Line 12 “Starry, starry…” +2 beats (31 → 74 %)",
    );
  });

  it("keeps a short lyric whole and says earlier with a minus", () => {
    const suggestion = {
      voice: 0,
      line: 0,
      beats: -1,
      shareBefore: 0.2,
      shareAfter: 0.55,
    };
    expect(lineSuggestionText(describeLineSuggestion(suggestion, starry))).toBe(
      "Line 1 “la la” −1 beat (20 → 55 %)",
    );
  });
});
