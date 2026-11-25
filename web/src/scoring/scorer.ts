/**
 * The scorer: the second pure step of scoring (#54).
 *
 * The Notes of one Voice, a Difficulty and a Beat range → each finalised Beat
 * value judged against the scored Note covering it, each scored Line's share
 * of the Line bonus and its Line rating when it ends, the three running sums,
 * and the total with its three parts. It is incremental: `judge` takes one
 * finalised Beat at a time, and a batch run (`scoreBeats`) is the same scorer
 * fed every stored Beat value in order. It also decides Finished.
 *
 * It also exports the per-reading hit test the trace drawing uses, built on
 * the same fold and tolerance code as the Beat judgement, so a reading's
 * colour matches scoring exactly.
 */

import { beatStart } from "../clock/beats";
import type { BeatValue } from "../generated/BeatValue";
import type { Difficulty } from "../generated/Difficulty";
import type { Note } from "../generated/Note";
import type { NoteKind } from "../generated/NoteKind";
import type { SongHeaders } from "../generated/SongHeaders";
import type { Voice } from "../generated/Voice";
import { isVoiced, passesMicThreshold, type BeatReading } from "./beatValues";
import type { MessageKey } from "../i18n/t";
import { SCORING, lineRatingWord, type LineRatingWord } from "./constants";

/** Which sum a Note kind's points go to. */
export type ScoreSum = "notes" | "golden";

/** A Note kind's factor, whether its pitch is checked, and its sum. */
interface NoteKindRule {
  factor: number;
  pitchChecked: boolean;
  sum: ScoreSum;
}

/** #54's Note kinds table. A Freestyle note has factor 0: never scored. */
const NOTE_KINDS: Record<NoteKind, NoteKindRule> = {
  normal: { factor: 1, pitchChecked: true, sum: "notes" },
  golden: { factor: 2, pitchChecked: true, sum: "golden" },
  rap: { factor: 1, pitchChecked: false, sum: "notes" },
  goldenRap: { factor: 2, pitchChecked: false, sum: "golden" },
  freestyle: { factor: 0, pitchChecked: false, sum: "notes" },
};

/** A Beat range, both ends included. */
export interface BeatRange {
  firstBeat: number;
  lastBeat: number;
}

export interface ScorerSetup {
  /** The Voice the Player sings. */
  voice: Voice;
  /** `#GAP` and `#BPM` (to place Notes against `#START`) and `#START`. */
  headers: Pick<SongHeaders, "gapSeconds" | "beatsPerMinute" | "startSeconds">;
  /** The Player's Difficulty, fixed for the Song. */
  difficulty: Difficulty;
  /** The Beat range to judge; defaults to the whole Voice. */
  range?: BeatRange;
}

/** The `t()` key of each Line rating word. */
const LINE_RATING_KEYS = {
  perfect: "sing.lineRating.perfect",
  great: "sing.lineRating.great",
  good: "sing.lineRating.good",
  ok: "sing.lineRating.ok",
} as const satisfies Record<LineRatingWord, MessageKey>;

/** The `t()` key a Line rating shows. */
export type LineRatingKey = (typeof LINE_RATING_KEYS)[LineRatingWord];

/** What a scored Line gave when it ended. */
export interface LineResult {
  /** The index of the Line in the Voice. */
  lineIndex: number;
  /** Points earned on this Line's own scored Notes. */
  linePoints: number;
  /** 9000 × lineValue / voiceValue. */
  lineMax: number;
  /** 0 … 1. */
  linePerfection: number;
  /** What the Line added to the Line bonus sum. */
  bonus: number;
  /** The Line rating, 0 … 8. */
  rating: number;
  /** The word the rating shows, as a `t()` key, or `null` for none. */
  word: LineRatingKey | null;
}

/** The three running sums, unrounded. */
export interface ScoreSums {
  notes: number;
  golden: number;
  lineBonus: number;
}

/** The total and its three parts, whole numbers that add up to the total. */
export interface Score {
  total: number;
  notes: number;
  golden: number;
  lineBonus: number;
}

/** What judging one Beat gave. */
export type BeatJudgement = (
  | { beat: number; judged: false }
  | {
      beat: number;
      judged: true;
      hit: boolean;
      /** Points this Beat earned (0 on a miss). */
      points: number;
      /** The sum the points went to. */
      sum: ScoreSum;
      /** The scored Note the Beat belongs to. */
      note: Note;
      /** The index of that Note's Line in the Voice. */
      lineIndex: number;
    }
) & {
  /** The scored Lines this Beat ended, in the order they ended. */
  lineEnds: LineResult[];
};

export interface Scorer {
  /** The Beat range being judged. */
  readonly range: BeatRange;
  /** Σ length × factor over the Voice's scored Notes. */
  readonly voiceValue: number;
  /**
   * Judges one finalised Beat. Beats must come in ascending order, each at
   * most once; a Beat may be skipped (it is then never judged).
   */
  judge(beat: number, value: BeatValue): BeatJudgement;
  /** The running sums. */
  sums(): ScoreSums;
  /** The running total and its parts: `roundScore` of the current sums. */
  score(): Score;
  /** Every scored Line ended so far, in the order they ended. */
  lineResults(): LineResult[];
  /**
   * Whether a Score ending at this Song time (seconds) is Finished: the
   * time passed the end of the Voice's last scored Note in the range. A
   * Voice with no scored Notes is always Finished.
   */
  isFinished(songTime: number): boolean;
  /**
   * Restart (#158): forgets every judged Beat, the sums and the ended Lines,
   * so judging starts over from the first Beat of the range.
   */
  reset(): void;
}

/** A scored Note, with the index of its Line. */
interface ScoredNote {
  note: Note;
  lineIndex: number;
  rule: NoteKindRule;
}

/**
 * The whole Voice as a Beat range: from the first Beat of its first Note to
 * the last Beat of its last Note.
 */
export function wholeVoice(voice: Voice): BeatRange {
  let firstBeat = Infinity;
  let lastBeat = -Infinity;
  for (const line of voice.lines) {
    for (const note of line.notes) {
      firstBeat = Math.min(firstBeat, note.start);
      lastBeat = Math.max(lastBeat, note.start + Math.max(note.length, 1) - 1);
    }
  }
  return firstBeat <= lastBeat
    ? { firstBeat, lastBeat }
    : { firstBeat: 0, lastBeat: -1 };
}

/**
 * The octave-folded distance in cents from the Note to the sung pitch, in
 * `[−600, +600)`: an exact tritone folds downward. Both pitches are in
 * semitones with C on multiples of 12 (the Note's 0 = C4 = MIDI 60), so no
 * offset between them is needed.
 */
export function foldedCents(sungPitch: number, notePitch: number): number {
  const fold = SCORING.octaveFoldCents;
  const d = (sungPitch - notePitch) * 100;
  return d - 2 * fold * Math.floor((d + fold) / (2 * fold));
}

/** Whether a sung pitch is within the Difficulty's tolerance of the Note. */
function inTune(
  sungPitch: number,
  notePitch: number,
  difficulty: Difficulty,
): boolean {
  return (
    Math.abs(foldedCents(sungPitch, notePitch)) <=
    SCORING.toleranceCents[difficulty]
  );
}

/**
 * Whether a Beat value hits a Note: a Rap or Golden Rap note on voice without
 * pitch or a pitch; a Normal or Golden note only on a pitch within the
 * Difficulty's tolerance. A Freestyle note is never hit.
 */
export function beatHits(
  note: Pick<Note, "kind" | "pitch">,
  value: BeatValue,
  difficulty: Difficulty,
): boolean {
  const rule = NOTE_KINDS[note.kind];
  if (rule.factor === 0) return false;
  if (!rule.pitchChecked) return value.kind !== "noVoice";
  return value.kind === "pitch" && inTune(value.pitch, note.pitch, difficulty);
}

/**
 * The per-reading hit test for the trace drawing: whether one reading hits
 * the Note under it at a Difficulty. A Rap or Golden Rap note is hit when the
 * reading passes the Mic threshold; a Normal or Golden note when the reading
 * is voiced and its octave-folded distance is within the tolerance. It only
 * colours; scoring stays per Beat.
 */
export function readingHits(
  reading: Pick<BeatReading, "pitch" | "clarity" | "loudness">,
  micThresholdDbfs: number,
  note: Pick<Note, "kind" | "pitch">,
  difficulty: Difficulty,
): boolean {
  return beatHits(note, readingValue(reading, micThresholdDbfs), difficulty);
}

// Reused by `readingValue`, so the trace's per-point hit test allocates
// nothing; `readingHits` never lets one escape.
const NO_VOICE: BeatValue = { kind: "noVoice" };
const VOICE_WITHOUT_PITCH: BeatValue = { kind: "voiceWithoutPitch" };
const PITCH: { kind: "pitch"; pitch: number } = { kind: "pitch", pitch: 0 };

/** What one reading alone says, in Beat-value terms (only until the next call). */
function readingValue(
  reading: Pick<BeatReading, "pitch" | "clarity" | "loudness">,
  micThresholdDbfs: number,
): BeatValue {
  if (reading.pitch !== null && isVoiced(reading, micThresholdDbfs)) {
    PITCH.pitch = reading.pitch;
    return PITCH;
  }
  return passesMicThreshold(reading, micThresholdDbfs)
    ? VOICE_WITHOUT_PITCH
    : NO_VOICE;
}

/** Rounds half up (USDX rounds half to even; OpenStar differs on purpose). */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * The total and its three parts from the unrounded sums: the total is
 * `roundHalfUp(notes + golden + lineBonus)`; each part is rounded half up,
 * then moved by one to add up to the total, as USDX does.
 */
export function roundScore(sums: ScoreSums): Score {
  const total = roundHalfUp(sums.notes + sums.golden + sums.lineBonus);
  let notes = roundHalfUp(sums.notes);
  let golden = roundHalfUp(sums.golden);
  let lineBonus = roundHalfUp(sums.lineBonus);
  const parts = notes + golden + lineBonus;
  if (parts > total) {
    if (golden > 0) golden -= 1;
    else if (notes > 0) notes -= 1;
    else lineBonus -= 1;
  } else if (parts < total) {
    if (notes > 0 || golden === 0) notes += 1;
    else golden += 1;
  }
  return { total, notes, golden, lineBonus };
}

/** A scored Line: one with lineValue > 0. */
interface ScoredLine {
  lineIndex: number;
  lineValue: number;
  /** The last Beat of its scored Notes: the Line ends once it is judged. */
  lastBeat: number;
}

/** The scored Lines of the scored Notes, in the order they end. */
function scoredLines(scored: readonly ScoredNote[]): ScoredLine[] {
  const lines = new Map<number, ScoredLine>();
  for (const { note, lineIndex, rule } of scored) {
    const lastBeat = note.start + note.length - 1;
    const line = lines.get(lineIndex);
    if (line === undefined) {
      lines.set(lineIndex, {
        lineIndex,
        lineValue: note.length * rule.factor,
        lastBeat,
      });
    } else {
      line.lineValue += note.length * rule.factor;
      line.lastBeat = Math.max(line.lastBeat, lastBeat);
    }
  }
  return [...lines.values()].sort(
    (a, b) => a.lastBeat - b.lastBeat || a.lineIndex - b.lineIndex,
  );
}

/** #54's Line bonus and Line rating for one ended Line. */
function lineResult(
  line: ScoredLine,
  linePoints: number,
  voiceValue: number,
  scoredLineCount: number,
): LineResult {
  const margin = SCORING.linePerfectionMargin;
  const lineMax = (SCORING.notePoints * line.lineValue) / voiceValue;
  const reach = lineMax > margin ? lineMax - margin : lineMax;
  const linePerfection = Math.min(Math.max(linePoints / reach, 0), 1);
  const rating = roundHalfUp(linePerfection * SCORING.lineRatingScale);
  const word = lineRatingWord(rating);
  return {
    lineIndex: line.lineIndex,
    linePoints,
    lineMax,
    linePerfection,
    bonus: (SCORING.lineBonusPoints / scoredLineCount) * linePerfection,
    rating,
    word: word === null ? null : LINE_RATING_KEYS[word],
  };
}

/** Starts a scorer for one Player on one Voice. */
export function createScorer(setup: ScorerSetup): Scorer {
  const { voice, headers, difficulty } = setup;
  const range = setup.range ?? wholeVoice(voice);
  const scored = scoredNotes(voice, headers, range);
  const voiceValue = scored.reduce(
    (sum, { note, rule }) => sum + note.length * rule.factor,
    0,
  );
  // Each Beat belongs to the first scored Note covering it, in Note order.
  const owners = new Map<number, ScoredNote>();
  if (voiceValue > 0) {
    for (const scoredNote of scored) {
      const { start, length } = scoredNote.note;
      for (let beat = start; beat < start + length; beat++) {
        if (!owners.has(beat)) owners.set(beat, scoredNote);
      }
    }
  }
  const lines = voiceValue > 0 ? scoredLines(scored) : [];
  // Finished once Song time passes the end of the last scored Note.
  const finishedAfter = scored.reduce(
    (end, { note }) =>
      Math.max(end, beatStart(headers, note.start + note.length)),
    -Infinity,
  );
  const sums: ScoreSums = { notes: 0, golden: 0, lineBonus: 0 };
  const linePoints = new Map<number, number>();
  const ended: LineResult[] = [];
  let nextLine = 0;
  let lastJudged = -Infinity;

  /** Ends every Line whose last scored Beat is at or before `beat`. */
  function endLines(beat: number): LineResult[] {
    const results: LineResult[] = [];
    for (
      let line = lines[nextLine];
      line !== undefined && line.lastBeat <= beat;
      line = lines[++nextLine]
    ) {
      const result = lineResult(
        line,
        linePoints.get(line.lineIndex) ?? 0,
        voiceValue,
        lines.length,
      );
      sums.lineBonus += result.bonus;
      results.push(result);
    }
    ended.push(...results);
    return results;
  }

  return {
    range,
    voiceValue,
    judge(beat, value) {
      if (beat <= lastJudged) {
        throw new Error(`Beat ${String(beat)} judged out of order or twice`);
      }
      lastJudged = beat;
      const owner = owners.get(beat);
      if (owner === undefined) {
        return { beat, judged: false, lineEnds: endLines(beat) };
      }
      const { note, lineIndex, rule } = owner;
      const hit = beatHits(note, value, difficulty);
      const points = hit ? (SCORING.notePoints / voiceValue) * rule.factor : 0;
      sums[rule.sum] += points;
      linePoints.set(lineIndex, (linePoints.get(lineIndex) ?? 0) + points);
      return {
        beat,
        judged: true,
        hit,
        points,
        sum: rule.sum,
        note,
        lineIndex,
        lineEnds: endLines(beat),
      };
    },
    sums: () => ({ ...sums }),
    score: () => roundScore(sums),
    lineResults: () => [...ended],
    isFinished: (songTime) => songTime > finishedAfter,
    reset() {
      sums.notes = 0;
      sums.golden = 0;
      sums.lineBonus = 0;
      linePoints.clear();
      ended.length = 0;
      nextLine = 0;
      lastJudged = -Infinity;
    },
  };
}

/**
 * The scored Notes of a Voice in Note order: factor > 0, length > 0, wholly
 * inside the range, and not starting before `#START`.
 */
function scoredNotes(
  voice: Voice,
  headers: ScorerSetup["headers"],
  range: BeatRange,
): ScoredNote[] {
  return voice.lines.flatMap((line, lineIndex) =>
    line.notes.flatMap((note) => {
      const rule = NOTE_KINDS[note.kind];
      const scored =
        rule.factor > 0 &&
        note.length > 0 &&
        note.start >= range.firstBeat &&
        note.start + note.length - 1 <= range.lastBeat &&
        (headers.startSeconds === null ||
          beatStart(headers, note.start) >= headers.startSeconds);
      return scored ? [{ note, lineIndex, rule }] : [];
    }),
  );
}

/** A batch run: the scorer fed stored Beat values in order. */
export function scoreBeats(
  setup: ScorerSetup,
  /** The Beat the first value belongs to. */
  firstBeat: number,
  values: readonly BeatValue[],
): ScoreSums & {
  range: BeatRange;
  voiceValue: number;
  judgements: BeatJudgement[];
  /** Every scored Line that ended, in the order they ended. */
  lineResults: LineResult[];
  /** The total and its parts. */
  score: Score;
} {
  const scorer = createScorer(setup);
  const judgements = values.map((value, i) =>
    scorer.judge(firstBeat + i, value),
  );
  return {
    range: scorer.range,
    voiceValue: scorer.voiceValue,
    ...scorer.sums(),
    judgements,
    lineResults: scorer.lineResults(),
    score: scorer.score(),
  };
}
