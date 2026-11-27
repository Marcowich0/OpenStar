import { describe, expect, it } from "vitest";

import type { BeatValue } from "../generated/BeatValue";
import type { Difficulty } from "../generated/Difficulty";
import type { NoteKind } from "../generated/NoteKind";
import type { Voice } from "../generated/Voice";
import { beatValues, type BeatReading } from "./beatValues";
import totalsFile from "../../../fixtures/scoring/totals.json?raw";
import {
  createScorer,
  foldedCents,
  readingHits,
  roundScore,
  scoreBeats,
  type BeatRange,
  type Score,
  type ScoreSums,
} from "./scorer";

/** A Beat value as the fixtures write it: `null`, `"voice"` or a pitch. */
type FixtureValue = null | "voice" | number;
/** One value, or one value repeated `times` Beats in a row. */
type FixtureBeatValue = FixtureValue | { repeat: FixtureValue; times: number };

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
    finished?: { songTime: number; finished: boolean }[];
    expected: {
      firstBeat: number;
      lastBeat: number;
      voiceValue: number;
      notes: number;
      golden: number;
      hitBeats?: number[];
      missedBeats?: number[];
      lineBonus?: number;
      lines?: {
        lineIndex: number;
        rating: number;
        word: string | null;
        bonus: number;
      }[];
      score?: Score;
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

function beatValue(value: FixtureValue): BeatValue {
  if (value === null) return { kind: "noVoice" };
  if (value === "voice") return { kind: "voiceWithoutPitch" };
  return { kind: "pitch", pitch: value };
}

/** The fixture's compact Beat values, one per Beat. */
function beatValueList(values: FixtureBeatValue[]): BeatValue[] {
  return values.flatMap((value) =>
    value !== null && typeof value === "object"
      ? Array.from({ length: value.times }, () => beatValue(value.repeat))
      : [beatValue(value)],
  );
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
      const setup = {
        voice,
        headers: f,
        difficulty: player.difficulty,
        ...(player.range ? { range: player.range } : {}),
      };
      const result = scoreBeats(
        setup,
        player.firstBeat,
        beatValueList(player.beatValues),
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
      if (expected.hitBeats) {
        expect(judged.filter((j) => j.hit).map((j) => j.beat)).toEqual(
          expected.hitBeats,
        );
      }
      if (expected.missedBeats) {
        expect(judged.filter((j) => !j.hit).map((j) => j.beat)).toEqual(
          expected.missedBeats,
        );
      }
      if (expected.lineBonus !== undefined) {
        expect(result.lineBonus).toBeCloseTo(expected.lineBonus, 9);
      }
      if (expected.lines) {
        expect(result.lineResults).toHaveLength(expected.lines.length);
        expected.lines.forEach((line, i) => {
          const got = result.lineResults[i];
          expect(got).toMatchObject({
            lineIndex: line.lineIndex,
            rating: line.rating,
            word: line.word,
          });
          expect(got?.bonus).toBeCloseTo(line.bonus, 9);
        });
      }
      if (expected.score) expect(result.score).toEqual(expected.score);
      if (player.finished) {
        const scorer = createScorer(setup);
        for (const { songTime, finished } of player.finished) {
          expect({ songTime, finished: scorer.isFinished(songTime) }).toEqual({
            songTime,
            finished,
          });
        }
      }
    }
  });
});

describe("the total and its parts", () => {
  const totals = JSON.parse(totalsFile) as {
    cases: { name: string; sums: ScoreSums; score: Score }[];
  };

  it.each(totals.cases)("$name", ({ sums, score }) => {
    expect(roundScore(sums)).toEqual(score);
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

  it("reports its running sums and total after each finalised Beat", () => {
    // voiceValue = 1 + 2 + 1 = 4: 2250 × factor per hit Beat. Two scored
    // Lines: each is worth 500 of the Line bonus.
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    expect(scorer.voiceValue).toBe(4);
    expect(scorer.range).toEqual({ firstBeat: 0, lastBeat: 4 });
    expect(scorer.judge(0, { kind: "pitch", pitch: 48 }).lineEnds).toEqual([]);
    expect(scorer.sums()).toEqual({ notes: 2250, golden: 0, lineBonus: 0 });
    expect(scorer.score().total).toBe(2250);
    // Beat 1 is Line 0's last scored Beat: the Line ends with it.
    expect(scorer.judge(1, { kind: "pitch", pitch: 60 }).lineEnds).toEqual([
      {
        lineIndex: 0,
        linePoints: 6750,
        lineMax: 6750,
        linePerfection: 1,
        bonus: 500,
        rating: 8,
        word: "sing.lineRating.perfect",
      },
    ]);
    expect(scorer.sums()).toEqual({
      notes: 2250,
      golden: 4500,
      lineBonus: 500,
    });
    expect(scorer.score().total).toBe(7250);
    expect(scorer.judge(2, { kind: "pitch", pitch: 60 })).toEqual({
      beat: 2,
      judged: false,
      lineEnds: [],
    });
    expect(scorer.judge(4, { kind: "voiceWithoutPitch" })).toMatchObject({
      beat: 4,
      judged: true,
      hit: true,
      points: 2250,
      sum: "notes",
      lineIndex: 1,
      note: { kind: "rap", start: 4 },
      lineEnds: [{ lineIndex: 1, bonus: 500, rating: 8 }],
    });
    expect(scorer.sums()).toEqual({
      notes: 4500,
      golden: 4500,
      lineBonus: 1000,
    });
    expect(scorer.score()).toEqual({
      total: 10000,
      notes: 4500,
      golden: 4500,
      lineBonus: 1000,
    });
  });

  it("ends a Line whose last Beat was skipped at the next judged Beat", () => {
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    scorer.judge(0, { kind: "pitch", pitch: 60 });
    expect(scorer.judge(3, { kind: "noVoice" }).lineEnds).toMatchObject([
      { lineIndex: 0, linePoints: 2250, rating: 3 },
    ]);
  });

  it("gives no bonus for a Line not ended when the Song ends", () => {
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    scorer.judge(0, { kind: "pitch", pitch: 60 });
    expect(scorer.sums().lineBonus).toBe(0);
    expect(scorer.lineResults()).toEqual([]);
  });

  it("judges each Beat once, in order", () => {
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    scorer.judge(1, { kind: "noVoice" });
    expect(() => scorer.judge(1, { kind: "noVoice" })).toThrow();
    expect(() => scorer.judge(0, { kind: "noVoice" })).toThrow();
  });

  it("reset (Restart) clears the sums and ended Lines and judges from the start again", () => {
    const scorer = createScorer({ voice, headers, difficulty: "hard" });
    scorer.judge(0, { kind: "pitch", pitch: 60 });
    scorer.judge(1, { kind: "pitch", pitch: 60 });
    expect(scorer.lineResults()).toHaveLength(1);
    scorer.reset();
    expect(scorer.sums()).toEqual({ notes: 0, golden: 0, lineBonus: 0 });
    expect(scorer.lineResults()).toEqual([]);
    // From here it scores exactly as a scorer that never heard the first take.
    const fresh = createScorer({ voice, headers, difficulty: "hard" });
    for (const s of [scorer, fresh]) {
      s.judge(0, { kind: "noVoice" });
      s.judge(1, { kind: "pitch", pitch: 60 });
    }
    expect(scorer.lineResults()).toEqual(fresh.lineResults());
    expect(scorer.sums()).toEqual(fresh.sums());
    expect(scorer.sums().notes).toBe(0);
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

describe("scorer properties", () => {
  /** A small seeded generator (mulberry32), so a failure replays. */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const int = (r: () => number, lo: number, hi: number) =>
    lo + Math.floor(r() * (hi - lo + 1));
  function pick<T>(r: () => number, items: readonly T[]): T {
    const item = items[Math.floor(r() * items.length)];
    if (item === undefined) throw new Error("nothing to pick");
    return item;
  }

  const KINDS: NoteKind[] = [
    "normal",
    "golden",
    "rap",
    "goldenRap",
    "freestyle",
  ];
  const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
  const beatSeconds = 0.125;

  /** A random Song for one Player; Notes overlap only when `overlaps`. */
  function song(r: () => number, overlaps: boolean) {
    let beat = int(r, 0, 3);
    let line = 0;
    const voice: Voice = {
      lines: Array.from({ length: int(r, 1, 5) }, () => ({
        notes: Array.from({ length: int(r, 1, 4) }, () => {
          const start =
            overlaps && beat > 0 && r() < 0.2 ? beat - 1 : beat + int(r, 0, 2);
          const length = r() < 0.1 ? 0 : int(r, 1, 6);
          beat = start + Math.max(length, 1);
          return {
            kind: pick(r, KINDS),
            start,
            length,
            pitch: int(r, -12, 12),
            text: "la",
            line: ++line,
          };
        }),
        end: null,
      })),
    };
    const startSeconds = r() < 0.3 ? int(r, 0, beat) * beatSeconds : null;
    return {
      voice,
      headers: { gapSeconds: 0, beatsPerMinute: 480, startSeconds },
      difficulty: pick(r, DIFFICULTIES),
    };
  }

  /** A Beat value that hits the Note, an octave away at random. */
  function hitting(r: () => number, note: Voice["lines"][0]["notes"][0]) {
    if (note.kind === "rap" || note.kind === "goldenRap") {
      return r() < 0.5
        ? ({ kind: "voiceWithoutPitch" } as const)
        : ({ kind: "pitch", pitch: r() * 100 } as const);
    }
    const pitch = 60 + note.pitch + 12 * int(r, -1, 1) + (r() - 0.5) * 0.8;
    return { kind: "pitch", pitch } as const;
  }

  function anyValue(r: () => number): BeatValue {
    const x = r();
    if (x < 0.3) return { kind: "noVoice" };
    if (x < 0.5) return { kind: "voiceWithoutPitch" };
    return { kind: "pitch", pitch: 40 + r() * 40 };
  }

  /** One value per Beat of the range. */
  function rangeValues(
    setup: ReturnType<typeof song>,
    value: (beat: number) => BeatValue,
  ): BeatValue[] {
    const { range } = createScorer(setup);
    return Array.from(
      { length: range.lastBeat - range.firstBeat + 1 },
      (_, i) => value(range.firstBeat + i),
    );
  }

  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  it("a perfect run scores 10000", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const setup = song(r, false);
      const notes = setup.voice.lines.flatMap((l) => l.notes);
      const values = rangeValues(setup, (beat) => {
        const note = notes.find(
          (n) => n.start <= beat && beat < n.start + n.length,
        );
        return note ? hitting(r, note) : anyValue(r);
      });
      const result = scoreBeats(
        setup,
        createScorer(setup).range.firstBeat,
        values,
      );
      expect({ seed, total: result.score.total }).toEqual({
        seed,
        total: result.voiceValue > 0 ? 10000 : 0,
      });
    }
  });

  it("silence scores 0", () => {
    for (const seed of SEEDS) {
      const setup = song(random(seed), true);
      const values = rangeValues(setup, () => ({ kind: "noVoice" }));
      const result = scoreBeats(
        setup,
        createScorer(setup).range.firstBeat,
        values,
      );
      expect(result.score).toEqual({
        total: 0,
        notes: 0,
        golden: 0,
        lineBonus: 0,
      });
    }
  });

  it("the parts always add up to the total", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const setup = song(r, true);
      const values = rangeValues(setup, () => anyValue(r));
      const { score } = scoreBeats(
        setup,
        createScorer(setup).range.firstBeat,
        values,
      );
      expect(score.total).toBeLessThanOrEqual(10000);
      // Arbitrary sums too, not only those a Song can give.
      const sums = {
        notes: r() * 9000,
        golden: r() < 0.3 ? 0 : r() * 3000,
        lineBonus: r() < 0.3 ? 0 : r() * 1000,
      };
      for (const s of [score, roundScore(sums)]) {
        expect(s.notes + s.golden + s.lineBonus).toBe(s.total);
        expect(Math.min(s.notes, s.golden, s.lineBonus)).toBeGreaterThanOrEqual(
          0,
        );
      }
    }
  });

  it("more hit Beats never lower the Score", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const setup = song(r, true);
      const firstBeat = createScorer(setup).range.firstBeat;
      let values = rangeValues(setup, () => anyValue(r));
      let before = scoreBeats(setup, firstBeat, values);
      for (let step = 0; step < 5; step++) {
        const missed = before.judgements.filter((j) => j.judged && !j.hit);
        if (missed.length === 0) break;
        const miss = pick(r, missed);
        if (!miss.judged) throw new Error("not judged");
        values = values.map((v, i) =>
          firstBeat + i === miss.beat ? hitting(r, miss.note) : v,
        );
        const after = scoreBeats(setup, firstBeat, values);
        expect(after.score.total).toBeGreaterThanOrEqual(before.score.total);
        expect(after.notes + after.golden).toBeGreaterThan(
          before.notes + before.golden,
        );
        expect(after.lineBonus).toBeGreaterThanOrEqual(before.lineBonus);
        before = after;
      }
    }
  });

  it("the incremental scorer and a batch run give identical results", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const setup = song(r, true);
      const scorer = createScorer(setup);
      const firstBeat = scorer.range.firstBeat;
      const values = rangeValues(setup, () => anyValue(r));
      // Live: Beat by Beat, collecting each Line end as it happens.
      const lineEnds = values.flatMap(
        (value, i) => scorer.judge(firstBeat + i, value).lineEnds,
      );
      const batch = scoreBeats(setup, firstBeat, values);
      expect(lineEnds).toEqual(batch.lineResults);
      expect(scorer.lineResults()).toEqual(batch.lineResults);
      expect(scorer.sums()).toEqual({
        notes: batch.notes,
        golden: batch.golden,
        lineBonus: batch.lineBonus,
      });
      expect(scorer.score()).toEqual(batch.score);
    }
  });
});
