// The Timing editor's drag gestures (v1 spec #57, variant A of the
// prototype): what a drag that started on the detail view does once the
// pointer has moved `draggedSeconds` of Song time. Pure: each turns the model
// as it was when the drag started into the one edit a release would commit,
// and the hint shown while dragging. Needs only the model, never the Pitch
// track, so every drag tool works while the track is pending or failed.

import { t } from "../../i18n/t";
import type { EditDescription } from "../../timing/describeEdit";
import {
  moveNote,
  setNoteLength,
  shiftLines,
  stretchLines,
  type NoteIndex,
} from "../../timing/lineEdits";
import type { LineSelection } from "../../timing/selection";
import {
  moveSong,
  stretchAroundPin,
  type LineIndex,
} from "../../timing/songEdits";
import {
  currentTiming,
  noteTimes,
  type TimingEdit,
  type TimingModel,
} from "../../timing/timingModel";

/** What a drag started on, fixed for the drag's life. */
export type Drag =
  /** Empty space: moves the whole Song, or stretches around the pin. */
  | { kind: "song"; grabSeconds: number; pin: LineIndex | null }
  /** A selected Line: shifts the selection by whole Beats. */
  | { kind: "lines"; selection: LineSelection }
  /** The ◀▶ handle at the selection's end: stretches it. */
  | { kind: "stretch"; selection: LineSelection }
  /** Alt on a Note: moves it by whole Beats. */
  | { kind: "note"; note: NoteIndex }
  /** Alt on a Note's right end: changes its length. */
  | { kind: "noteEnd"; note: NoteIndex };

export interface DragResult {
  /** What releasing the pointer now commits; `null` changes nothing. */
  edit: TimingEdit | null;
  /** The hint shown while dragging; `null` with no edit. */
  hint: string | null;
}

const NOTHING: DragResult = { edit: null, hint: null };

/** The drag's edit and hint after the pointer moved `draggedSeconds`. */
export function dragTo(
  model: TimingModel,
  drag: Drag,
  draggedSeconds: number,
): DragResult {
  const timing = currentTiming(model);
  const secondsPerBeat = 60 / timing.grid.beatsPerMinute;
  const beats = Math.round(draggedSeconds / secondsPerBeat);
  let edit: TimingEdit | null;
  switch (drag.kind) {
    case "song":
      edit = drag.pin
        ? stretchAroundPin(model, {
            pin: drag.pin,
            grabSeconds: drag.grabSeconds,
            pointerSeconds: drag.grabSeconds + draggedSeconds,
          })
        : moveSong(model, draggedSeconds);
      break;
    case "lines":
      edit = beats === 0 ? null : shiftLines(model, drag.selection, beats);
      break;
    case "stretch": {
      const { voice, first, last } = drag.selection;
      const lines = timing.song.voices[voice]?.lines;
      const a = lines?.[first]?.notes[0];
      const b = lines?.[last]?.notes.at(-1);
      if (!a || !b) return NOTHING;
      const start = noteTimes(timing.grid, a).start;
      const length = noteTimes(timing.grid, b).end - start;
      edit =
        length > 0
          ? stretchLines(
              model,
              drag.selection,
              (length + draggedSeconds) / length,
            )
          : null;
      break;
    }
    case "note":
      edit = beats === 0 ? null : moveNote(model, drag.note, beats);
      break;
    case "noteEnd": {
      const { voice, line, note } = drag.note;
      const found = timing.song.voices[voice]?.lines[line]?.notes[note];
      edit = found
        ? setNoteLength(model, drag.note, found.length + beats)
        : null;
      break;
    }
  }
  if (!edit) return NOTHING;
  return { edit, hint: dragHint(edit.description, secondsPerBeat) };
}

/** Seconds rounded to hundredths, for the hint. */
const hundredths = (s: number) => Math.round(s * 100) / 100;

/** The hint for a drag's edit: the change in Beats and seconds, or the values. */
export function dragHint(
  d: EditDescription,
  secondsPerBeat: number,
): string | null {
  const beatsText = (key: "lines" | "note", beats: number) => {
    const count = Math.abs(beats);
    const seconds = hundredths(count * secondsPerBeat);
    if (key === "lines")
      return beats > 0
        ? t("timing.drag.beatsLater", { count, seconds })
        : t("timing.drag.beatsEarlier", { count, seconds });
    return beats > 0
      ? t("timing.drag.noteLater", { count, seconds })
      : t("timing.drag.noteEarlier", { count, seconds });
  };
  switch (d.kind) {
    case "moveSong": {
      const seconds = hundredths(Math.abs(d.toGapMs - d.fromGapMs) / 1000);
      const values = { seconds, from: d.fromGapMs, to: d.toGapMs };
      return d.toGapMs > d.fromGapMs
        ? t("timing.drag.songLater", values)
        : t("timing.drag.songEarlier", values);
    }
    case "stretchAroundPin":
      return t("timing.drag.stretchAroundPin", {
        fromBpm: d.fromBpm,
        toBpm: d.toBpm,
        fromGap: d.fromGapMs,
        toGap: d.toGapMs,
      });
    case "shiftLines":
      return beatsText("lines", d.toBeat - d.fromBeat);
    case "stretchLines":
      return t("timing.drag.stretchLines", { factor: d.factor });
    case "moveNote":
      return beatsText("note", d.toBeat - d.fromBeat);
    case "noteLength":
      return t("timing.drag.noteLength", {
        count: d.toLength,
        seconds: hundredths(d.toLength * secondsPerBeat),
      });
    case "nudgeSong":
    case "typeGap":
    case "typeBpm":
    case "typeVideoGap":
    case "tempoAroundPlayhead":
    case "fitToTheSinging":
    case "fitOffsetOnly":
      // Not made by a drag.
      return null;
  }
}
