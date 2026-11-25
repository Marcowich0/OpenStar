import { describe, expect, it } from "vitest";

import type { BeatValue } from "../generated/BeatValue";
import type { Difficulty } from "../generated/Difficulty";
import type { NoteKind } from "../generated/NoteKind";
import type { Voice } from "../generated/Voice";
import { beatValues, type BeatReading } from "./beatValues";
import {
  createScorer,
  foldedCents,
  readingHits,
  scoreBeats,
  type BeatRange,
} from "./scorer";

/** A Beat value as the fixtures write it: `null`, `"voice"` or a pitch. */
type FixtureBeatValue = null | "voice" | number;

interface FixtureNote {
  kind: NoteKind;
  start: number;
  length: number;
  pitch: number;
}

interface ScorerFixture {
  description: string;
  gapSeconds: number;
  beatsPerMinute: number;
  startSeconds: number | null;
  voices: { lines: { notes: FixtureNote[] }[] }[];
  players: {
    voice: number;
    difficulty: Difficulty;
    range?: BeatRange;
    firstBeat: number;
    beatValues: FixtureBeatValue[];
    expected: {
      firstBeat: number;
      lastBeat: number;
      voiceValue: number;
      notes: number;
      golden: number;
      hitBeats: number[];
      missedBeats: number[];
    };
  }[];
}

const files = import.meta.glob<string>(
  "../../../fixtures/scoring/scorer/*.json",
  { query: "?raw", import: "default", eager: true },
);

const fixtures = Object.entries(files).map(([path, text]) => ({
  file: path.split("/").pop() ?? path,
  ...(JSON.parse(text) as ScorerFixture),
}));

function beatValue(value: FixtureBeatValue): BeatValue {
  if (value === null) return { kind: "noVoice" };
  if (value === "voice") return { kind: "voiceWithoutPitch" };
  return { kind: "pitch", pitch: value };
}

/** The fixture's Voices as the parser gives them (text and line numbers made up). */
function voices(f: ScorerFixture): Voice[] {
  let line = 0;
  return f.voices.map((voice) => ({
    lines: voice.lines.map((l) => ({
      notes: l.notes.map((note) => ({ ...note, text: "la", line: ++line })),
      end: null,
    })),
  }));
}

describe("the scorer over stored Beat values", () => {
  it("has fixture files", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("$file: $description", (f) => {
    const songVoices = voices(f);
    for (const player of f.players) {
      const voice = songVoices[player.voice];
      if (voice === undefined)
        throw new Error(`no Voice ${String(player.voice)}`);
      const result = scoreBeats(
        {
          voice,
          headers: f,
          difficulty: player.difficulty,
          ...(player.range ? { range: player.range } : {}),
        },
        player.firstBeat,
        player.beatValues.map(beatValue),
      );
      const { expected } = player;
      expect(result.range).toEqual({
        firstBeat: expected.firstBeat,
        lastBeat: expected.lastBeat,
      });
      expect(result.voiceValue).toBe(expected.voiceValue);
      expect(result.notes).toBeCloseTo(expected.notes, 9);
      expect(result.golden).toBeCloseTo(expected.golden, 9);
      const judged = result.judgements.flatMap((j) =>
        j.judged ? [{ beat: j.beat, hit: j.hit }] : [],
      );
      expect(judged.filter((j) => j.hit).map((j) => j.beat)).toEqual(
        expected.hitBeats,
      );
      expect(judged.filter((j) => !j.hit).map((j) => j.beat)).toEqual(
        expected.missedBeats,
      );
    }
  });
});

describe("the octave fold", () => {
  it("folds an exact tritone either way to −600", () => {
    expect(foldedCents(66, 0)).toBe(-600);
    expect(foldedCents(54, 0)).toBe(-600);
    expect(foldedCents(65.99, 0)).toBeCloseTo(599, 9);
  });
});

describe("the incremental scorer", () => {
  const voice: Voice = {
    lines: [
      {
        notes: [
          { kind: "normal", start: 0, length: 1, pitch: 0, text: "a", line: 1 },
          { kind: "golden", start: 1, length: 1, pitch: 0, text: "b", line: 2 },
        ],
        end: { beat: 2, line: 3 },
      },
      {
        notes: [
          { kind: "rap", start: 4, length: 1, pitch: 0, text: "c", line: 4 },
        ],
        end: null,
      },
    ],
  };
  const headers = { gapSeconds: 0, beatsPerMinute: 480, startSeconds: null };

  it("reports its running sums after each finalised Beat", () => {
    // voiceValue = 1 + 2 + 1 = 4: 2250 × factor per hit Beat.
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    expect(scorer.voiceValue).toBe(4);
    expect(scorer.range).toEqual({ firstBeat: 0, lastBeat: 4 });
    scorer.judge(0, { kind: "pitch", pitch: 48 });
    expect(scorer.sums()).toEqual({ notes: 2250, golden: 0 });
    scorer.judge(1, { kind: "pitch", pitch: 60 });
    expect(scorer.sums()).toEqual({ notes: 2250, golden: 4500 });
    expect(scorer.judge(2, { kind: "pitch", pitch: 60 })).toEqual({
      beat: 2,
      judged: false,
    });
    expect(scorer.judge(4, { kind: "voiceWithoutPitch" })).toMatchObject({
      beat: 4,
      judged: true,
      hit: true,
      points: 2250,
      sum: "notes",
      lineIndex: 1,
      note: { kind: "rap", start: 4 },
    });
    expect(scorer.sums()).toEqual({ notes: 4500, golden: 4500 });
  });

  it("judges each Beat once, in order", () => {
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    scorer.judge(1, { kind: "noVoice" });
    expect(() => scorer.judge(1, { kind: "noVoice" })).toThrow();
    expect(() => scorer.judge(0, { kind: "noVoice" })).toThrow();
  });
});

describe("the per-reading hit test", () => {
  const threshold = -40;
  /** One reading each: in tune, at each boundary, off, octave and tritone away, unvoiced, too quiet. */
  const readings: Omit<BeatReading, "songTime">[] = [
    { pitch: 60, clarity: 0.9, loudness: -20 },
    { pitch: 60.5, clarity: 0.9, loudness: -20 },
    { pitch: 60.51, clarity: 0.9, loudness: -20 },
    { pitch: 58.5, clarity: 0.9, loudness: -20 },
    { pitch: 58.49, clarity: 0.9, loudness: -20 },
    { pitch: 62.5, clarity: 0.9, loudness: -20 },
    { pitch: 62.51, clarity: 0.9, loudness: -20 },
    { pitch: 72.3, clarity: 0.9, loudness: -20 },
    { pitch: 66, clarity: 0.9, loudness: -20 },
    { pitch: 60, clarity: 0.5, loudness: -20 },
    { pitch: null, clarity: 0, loudness: -20 },
    { pitch: 60, clarity: 0.9, loudness: -40 },
    { pitch: 60, clarity: 0.9, loudness: -40.1 },
  ];
  const kinds: NoteKind[] = ["normal", "golden", "rap", "goldenRap"];
  const difficulties: Difficulty[] = ["easy", "medium", "hard"];
  const grid = { gapSeconds: 0, beatsPerMinute: 60 };

  const cases = difficulties.flatMap((difficulty) =>
    kinds.map((kind) => ({ difficulty, kind })),
  );

  it.each(cases)(
    "agrees with the Beat judgement on $kind at $difficulty",
    ({ difficulty, kind }) => {
      const note = { kind, start: 0, length: 1, pitch: 0, text: "a", line: 1 };
      const voice: Voice = { lines: [{ notes: [note], end: null }] };
      for (const reading of readings) {
        // A Beat whose four readings all share this one value.
        const [value] = beatValues({
          readings: [0.1, 0.3, 0.5, 0.7].map((songTime) => ({
            ...reading,
            songTime,
          })),
          micThresholdDbfs: threshold,
          grid,
          firstBeat: 0,
          lastBeat: 0,
        });
        if (value === undefined) throw new Error("no Beat value");
        const [judgement] = scoreBeats(
          { voice, headers: { ...grid, startSeconds: null }, difficulty },
          0,
          [value],
        ).judgements;
        if (!judgement?.judged) throw new Error("Beat not judged");
        expect(readingHits(reading, threshold, note, difficulty)).toBe(
          judgement.hit,
        );
      }
    },
  );

  it("colours a reading by the scoring rules", () => {
    const normal = { kind: "normal", pitch: 0 } as const;
    const rap = { kind: "rap", pitch: 0 } as const;
    const unvoiced = { pitch: null, clarity: 0, loudness: -20 };
    const quiet = { pitch: 60, clarity: 0.9, loudness: -50 };
    expect(readingHits(unvoiced, threshold, rap, "hard")).toBe(true);
    expect(readingHits(unvoiced, threshold, normal, "easy")).toBe(false);
    expect(readingHits(quiet, threshold, rap, "easy")).toBe(false);
    expect(readingHits(quiet, threshold, normal, "easy")).toBe(false);
    expect(
      readingHits(
        { pitch: 73.5, clarity: 0.9, loudness: -20 },
        threshold,
        normal,
        "medium",
      ),
    ).toBe(true);
    expect(
      readingHits(
        { pitch: 60, clarity: 0.9, loudness: -20 },
        threshold,
        { kind: "freestyle", pitch: 0 },
        "easy",
      ),
    ).toBe(false);
  });
});
