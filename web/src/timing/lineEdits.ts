/**
 * Line and Note gestures of the Timing editor: shift or stretch a Line
 * selection, nudge it with `,`/`.`, move one Note or change its length. Each
 * turns the model and the gesture's inputs into one edit, or `null` when it
 * would change nothing. Notes and Line breaks move by whole Beats only, a
 * Note's length stays at least 1 Beat, and every Line break an edit touches
 * is clamped between the end of its Line's last Note and the start of the
 * next Line's first Note.
 */

import type { Line } from "../generated/Line";
import type { TimingOperation } from "../generated/TimingOperation";
import type { EditDescription } from "./describeEdit";
import type { LineSelection } from "./selection";
import { round2 } from "./songEdits";
import {
  currentTiming,
  type NudgeKey,
  type TimingEdit,
  type TimingModel,
} from "./timingModel";

/** One Note: indices into `voices`, that Voice's `lines` and its `notes`. */
export interface NoteIndex {
  readonly voice: number;
  readonly line: number;
  readonly note: number;
}

/** The Beats of one Voice while a gesture changes them. */
interface Draft {
  /** Per Line, per Note: start and length in Beats. */
  readonly notes: { start: number; length: number }[][];
  /** Per Line: the Beat of its Line end marker, or `null` without one. */
  readonly ends: (number | null)[];
}

/** The Voice's current Beats, copied for a gesture to change. */
function draftOf(lines: readonly Line[]): Draft {
  return {
    notes: lines.map((line) =>
      line.notes.map(({ start, length }) => ({ start, length })),
    ),
    ends: lines.map((line) => line.end?.beat ?? null),
  };
}

/**
 * Keeps the Line breaks after Lines `from`…`to` between the end of their
 * Line's last Note and the start of the next Line's first Note. When those
 * overlap, the break goes to the next Line's start.
 */
function clampBreaks(draft: Draft, from: number, to: number) {
  for (let k = Math.max(0, from); k <= to; k++) {
    const beat = draft.ends[k];
    const last = draft.notes[k]?.at(-1);
    const next = draft.notes[k + 1]?.[0];
    if (beat == null || !last || !next) continue;
    const lo = last.start + last.length;
    const hi = next.start;
    draft.ends[k] = Math.max(Math.min(beat, hi), Math.min(lo, hi));
  }
}

/**
 * The operations that take `lines` to `draft` for the Notes of Lines
 * `first`…`last` and the Line breaks after Lines `first − 1`…`last` (all an
 * edit of that range can change). With `all`, every Note start and Line
 * break of that set is written even when unchanged, so a nudge that replaces
 * the last one leaves the same timing as stacking them would.
 */
function operationsFor(
  lines: readonly Line[],
  draft: Draft,
  first: number,
  last: number,
  all = false,
): TimingOperation[] {
  const notes: TimingOperation[] = [];
  const ends: TimingOperation[] = [];
  for (let k = Math.max(0, first - 1); k <= last; k++) {
    const line = lines[k];
    if (!line) continue;
    if (k >= first) {
      line.notes.forEach((note, i) => {
        const to = draft.notes[k]?.[i];
        if (!to) return;
        if (all || to.start !== note.start) {
          notes.push({ op: "setNoteStart", line: note.line, start: to.start });
        }
        if (to.length !== note.length) {
          notes.push({
            op: "setNoteLength",
            line: note.line,
            length: to.length,
          });
        }
      });
    }
    const beat = draft.ends[k];
    if (line.end && beat != null && (all || beat !== line.end.beat)) {
      ends.push({ op: "setLineEnd", line: line.end.line, beat });
    }
  }
  return [...notes, ...ends];
}

/** An edit from `operations`, or `null` when they change nothing. */
function edit(
  operations: TimingOperation[],
  description: EditDescription,
  changed: boolean,
  merge?: NudgeKey,
): TimingEdit | null {
  if (!changed) return null;
  return { operations, description, ...(merge && { merge }) };
}

/** The selected Voice's Lines, or `null` when the selection is not there. */
function selectedLines(
  model: TimingModel,
  { voice, first, last }: LineSelection,
): readonly Line[] | null {
  const lines = currentTiming(model).song.voices[voice]?.lines;
  if (!lines || first < 0 || last >= lines.length || first > last) return null;
  return lines;
}

/** Shifts the selection by `beats`; `merge` and `all` for nudges. */
function shift(
  model: TimingModel,
  selection: LineSelection,
  beats: number,
  merge?: NudgeKey,
): TimingEdit | null {
  const lines = selectedLines(model, selection);
  const whole = Math.round(beats);
  if (!lines || !Number.isFinite(whole) || whole === 0) return null;
  const { voice, first, last } = selection;
  const draft = draftOf(lines);
  for (let k = first; k <= last; k++) {
    for (const note of draft.notes[k] ?? []) note.start += whole;
    const end = draft.ends[k];
    if (k < last && end != null) draft.ends[k] = end + whole;
  }
  clampBreaks(draft, first - 1, last);
  const fromBeat = lines[first]?.notes[0]?.start ?? 0;
  return edit(
    operationsFor(lines, draft, first, last, merge !== undefined),
    {
      kind: "shiftLines",
      voice,
      firstLine: first,
      lastLine: last,
      fromBeat,
      toBeat: fromBeat + whole,
    },
    true,
    merge,
  );
}

/** Drag the selection (or Apply a Line suggestion): by whole `beats`. */
export function shiftLines(
  model: TimingModel,
  selection: LineSelection,
  beats: number,
): TimingEdit | null {
  return shift(model, selection, beats);
}

/**
 * `,` (direction −1) and `.` (+1) with a selection: shifts it by −/+1 Beat,
 * with Shift −/+4. Repeated nudges of one selection merge (see `commit`).
 */
export function nudgeLines(
  model: TimingModel,
  selection: LineSelection,
  { direction, shift: big }: { direction: -1 | 1; shift: boolean },
): TimingEdit | null {
  const { voice, first, last } = selection;
  return shift(model, selection, direction * (big ? 4 : 1), {
    kind: "nudgeLines",
    target: `lines:${String(voice)}:${String(first)}-${String(last)}`,
  });
}

/** The smallest stretch factor. */
export const MIN_STRETCH = 0.3;

/**
 * Drag the ◀▶ handle: stretches the selection by `factor` (rounded to 0.01,
 * at least 0.3) around its first Note. Every Note start and end and every
 * Line break inside maps to `anchor + round((beat − anchor) × factor)`; a
 * Note's length stays at least 1 Beat.
 */
export function stretchLines(
  model: TimingModel,
  selection: LineSelection,
  factor: number,
): TimingEdit | null {
  const lines = selectedLines(model, selection);
  const f = Math.max(MIN_STRETCH, round2(factor));
  if (!lines || !Number.isFinite(f) || f === 1) return null;
  const { voice, first, last } = selection;
  const draft = draftOf(lines);
  const anchor = lines[first]?.notes[0]?.start ?? 0;
  const map = (beat: number) => anchor + Math.round((beat - anchor) * f);
  for (let k = first; k <= last; k++) {
    for (const note of draft.notes[k] ?? []) {
      const start = map(note.start);
      const end = map(note.start + note.length);
      note.start = start;
      note.length = Math.max(1, end - start);
    }
    const end = draft.ends[k];
    if (k < last && end != null) draft.ends[k] = map(end);
  }
  clampBreaks(draft, first - 1, last);
  const operations = operationsFor(lines, draft, first, last);
  return edit(
    operations,
    {
      kind: "stretchLines",
      voice,
      firstLine: first,
      lastLine: last,
      factor: f,
    },
    operations.length > 0,
  );
}

/** One Note's Voice, Line and current Beats, or `null` when not there. */
function noteAt(model: TimingModel, { voice, line, note }: NoteIndex) {
  const lines = currentTiming(model).song.voices[voice]?.lines;
  const found = lines?.[line]?.notes[note];
  return lines && found ? { lines, found } : null;
}

/** The lyric shown for a Note in the edit list: its text, trimmed. */
const lyric = (text: string) => text.trim();

/** Alt-drag a Note: moves it by whole `beats`. */
export function moveNote(
  model: TimingModel,
  index: NoteIndex,
  beats: number,
): TimingEdit | null {
  const at = noteAt(model, index);
  const whole = Math.round(beats);
  if (!at || !Number.isFinite(whole) || whole === 0) return null;
  const draft = draftOf(at.lines);
  const moved = draft.notes[index.line]?.[index.note];
  if (moved) moved.start += whole;
  clampBreaks(draft, index.line - 1, index.line);
  return edit(
    operationsFor(at.lines, draft, index.line, index.line),
    {
      kind: "moveNote",
      voice: index.voice,
      lineIndex: index.line,
      text: lyric(at.found.text),
      fromBeat: at.found.start,
      toBeat: at.found.start + whole,
    },
    true,
  );
}

/** Alt-drag a Note's right end: its length in whole Beats, at least 1. */
export function setNoteLength(
  model: TimingModel,
  index: NoteIndex,
  length: number,
): TimingEdit | null {
  const at = noteAt(model, index);
  const whole = Math.max(1, Math.round(length));
  if (!at || !Number.isFinite(whole) || whole === at.found.length) return null;
  const draft = draftOf(at.lines);
  const resized = draft.notes[index.line]?.[index.note];
  if (resized) resized.length = whole;
  clampBreaks(draft, index.line, index.line);
  return edit(
    operationsFor(at.lines, draft, index.line, index.line),
    {
      kind: "noteLength",
      voice: index.voice,
      lineIndex: index.line,
      text: lyric(at.found.text),
      fromLength: at.found.length,
      toLength: whole,
    },
    true,
  );
}
