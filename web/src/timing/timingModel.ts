/**
 * The Timing editor's edit model: the parsed Song as loaded plus the edits
 * made since, each a list of timing operations (the generated
 * `TimingOperation`, which the server's patcher applies on save). Everything
 * the editor shows (`#GAP`, `#BPM`, `#VIDEOGAP`, every Note's Beats and Song
 * time) is derived from the two. Pure: no DOM, no clock; callers pass `now`.
 */

import { beatStart, type BeatGrid } from "../clock/beats";
import type { Note } from "../generated/Note";
import type { ParsedSong } from "../generated/ParsedSong";
import type { TimingOperation } from "../generated/TimingOperation";
import { mergeDescriptions, type EditDescription } from "./describeEdit";

/** One undo step: the operations one gesture produced, and its description. */
export interface TimingEdit {
  readonly operations: readonly TimingOperation[];
  readonly description: EditDescription;
  /** Set on nudges: repeated nudges of one kind on one target merge. */
  readonly merge?: NudgeKey;
}

/** What makes two nudges "the same kind on the same target". */
export interface NudgeKey {
  readonly kind: string;
  readonly target: string;
}

export interface TimingModel {
  /** The Song as loaded (or as last saved). */
  readonly song: ParsedSong;
  /** The edits in effect, oldest first. */
  readonly applied: readonly AppliedEdit[];
  /** Undone edits, the next one to redo last. A new edit clears them. */
  readonly undone: readonly AppliedEdit[];
}

/** An edit in the history, with when it was committed (ms, caller's clock). */
export interface AppliedEdit extends TimingEdit {
  readonly at: number;
}

/** The timing the editor shows: the loaded Song with every edit applied. */
export interface CurrentTiming {
  /** `#GAP` in milliseconds, as the file holds it. */
  readonly gapMs: number;
  /** `#BPM` as the file holds it (a quarter of the real beat rate). */
  readonly bpm: number;
  /** `#VIDEOGAP` in seconds, or `null` when the file has none. */
  readonly videoGapSeconds: number | null;
  /** The Beat grid for `beatAt` / `beatStart`. */
  readonly grid: BeatGrid;
  /** The Song with the edited headers, Note Beats and Line end Beats. */
  readonly song: ParsedSong;
}

/** How long (ms) a nudge may follow the last one and still merge with it. */
export const NUDGE_MERGE_MS = 1500;

/** A fresh model for a Song as loaded: no edits. */
export function openTimingModel(song: ParsedSong): TimingModel {
  return { song, applied: [], undone: [] };
}

/** Every operation in effect, in order: what Save sends. */
export function operationsOf(model: TimingModel): TimingOperation[] {
  return model.applied.flatMap((edit) => edit.operations);
}

/** Cleans float noise from `seconds × 1000` (a file GAP may have decimals). */
const toMs = (seconds: number) => Math.round(seconds * 1e9) / 1e6;

/** The loaded Song with `operations` applied in order. */
export function applyOperations(
  song: ParsedSong,
  operations: readonly TimingOperation[],
): ParsedSong {
  if (operations.length === 0) return song;
  const headers = { ...song.headers };
  const starts = new Map<number, number>();
  const lengths = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const op of operations) {
    switch (op.op) {
      case "setGap":
        headers.gapSeconds = op.seconds;
        break;
      case "setBpm":
        headers.beatsPerMinute = op.beatsPerMinute;
        break;
      case "setVideoGap":
        headers.videoGapSeconds = op.seconds;
        break;
      case "setNoteStart":
        starts.set(op.line, op.start);
        break;
      case "setNoteLength":
        lengths.set(op.line, op.length);
        break;
      case "setLineEnd":
        ends.set(op.line, op.beat);
        break;
    }
  }
  if (starts.size === 0 && lengths.size === 0 && ends.size === 0) {
    return { ...song, headers };
  }
  return {
    headers,
    voices: song.voices.map((voice) => ({
      lines: voice.lines.map((line) => ({
        notes: line.notes.map((note) => ({
          ...note,
          start: starts.get(note.line) ?? note.start,
          length: lengths.get(note.line) ?? note.length,
        })),
        end: line.end && {
          ...line.end,
          beat: ends.get(line.end.line) ?? line.end.beat,
        },
      })),
    })),
  };
}

/** The timing the editor shows now. */
export function currentTiming(model: TimingModel): CurrentTiming {
  const song = applyOperations(model.song, operationsOf(model));
  const { gapSeconds, beatsPerMinute, videoGapSeconds } = song.headers;
  return {
    gapMs: toMs(gapSeconds),
    bpm: beatsPerMinute / 4,
    videoGapSeconds,
    grid: { gapSeconds, beatsPerMinute },
    song,
  };
}

/** A Note's Song time, `[start, end)` in seconds, on `grid`. */
export function noteTimes(
  grid: BeatGrid,
  note: Pick<Note, "start" | "length">,
): { start: number; end: number } {
  return {
    start: beatStart(grid, note.start),
    end: beatStart(grid, note.start + note.length),
  };
}

/**
 * Adds `edit` to the history at `now` (ms) and clears the undone edits. A
 * nudge merges into the last edit when that is a nudge of the same kind on
 * the same target, made at most `NUDGE_MERGE_MS` before.
 */
export function commit(
  model: TimingModel,
  edit: TimingEdit,
  now: number,
): TimingModel {
  const last = model.applied.at(-1);
  if (
    edit.merge &&
    last?.merge &&
    model.undone.length === 0 &&
    last.merge.kind === edit.merge.kind &&
    last.merge.target === edit.merge.target &&
    now - last.at <= NUDGE_MERGE_MS
  ) {
    const merged: AppliedEdit = {
      ...edit,
      description: mergeDescriptions(last.description, edit.description),
      at: now,
    };
    return { ...model, applied: [...model.applied.slice(0, -1), merged] };
  }
  return {
    ...model,
    applied: [...model.applied, { ...edit, at: now }],
    undone: [],
  };
}

/** Takes back the last edit; with none, returns `model` unchanged. */
export function undo(model: TimingModel): TimingModel {
  const last = model.applied.at(-1);
  if (!last) return model;
  return {
    ...model,
    applied: model.applied.slice(0, -1),
    undone: [...model.undone, last],
  };
}

/** Makes the last undone edit again; with none, returns `model` unchanged. */
export function redo(model: TimingModel): TimingModel {
  const next = model.undone.at(-1);
  if (!next) return model;
  return {
    ...model,
    applied: [...model.applied, next],
    undone: model.undone.slice(0, -1),
  };
}

/** Back to the file: drops every unsaved edit, undone ones included. */
export function backToTheFile(model: TimingModel): TimingModel {
  return openTimingModel(model.song);
}

/** One row of the edit list. */
export interface EditListEntry {
  readonly description: EditDescription;
  /** Undone: shown struck through until a new edit clears it. */
  readonly undone: boolean;
}

/** The edit list: the edits in effect, then the undone ones in redo order. */
export function editList(model: TimingModel): EditListEntry[] {
  return [
    ...model.applied.map((e) => ({
      description: e.description,
      undone: false,
    })),
    ...model.undone
      .toReversed()
      .map((e) => ({ description: e.description, undone: true })),
  ];
}
