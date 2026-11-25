/**
 * The scorer: the second pure step of scoring (#54).
 *
 * The Notes of one Voice, a Difficulty and a Beat range → each finalised Beat
 * value judged against the scored Note covering it, and the running Notes sum
 * and golden sum. It is incremental: `judge` takes one finalised Beat at a
 * time, and a batch run (`scoreBeats`) is the same scorer fed every stored
 * Beat value in order.
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
import { SCORING } from "./constants";

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

/** What judging one Beat gave. */
export type BeatJudgement =
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
  sums(): { notes: number; golden: number };
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
  const sums = { notes: 0, golden: 0 };
  let lastJudged = -Infinity;

  return {
    range,
    voiceValue,
    judge(beat, value) {
      if (beat <= lastJudged) {
        throw new Error(`Beat ${String(beat)} judged out of order or twice`);
      }
      lastJudged = beat;
      const owner = owners.get(beat);
      if (owner === undefined) return { beat, judged: false };
      const { note, lineIndex, rule } = owner;
      const hit = beatHits(note, value, difficulty);
      const points = hit ? (SCORING.notePoints / voiceValue) * rule.factor : 0;
      sums[rule.sum] += points;
      return {
        beat,
        judged: true,
        hit,
        points,
        sum: rule.sum,
        note,
        lineIndex,
      };
    },
    sums: () => ({ ...sums }),
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
): {
  range: BeatRange;
  voiceValue: number;
  notes: number;
  golden: number;
  judgements: BeatJudgement[];
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
  };
}
