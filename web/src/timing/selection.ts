/**
 * The Timing editor's Line selection: one Line, or a contiguous range of
 * Lines in one Voice. A click selects a Line; Shift-click extends the range
 * from the Line first clicked (the anchor); Esc clears it.
 */

import type { LineIndex } from "./songEdits";

/** Lines `first`…`last` (indices into the Voice's `lines`) of `voice`. */
export interface LineSelection {
  readonly voice: number;
  /** The Line clicked first: Shift-click extends from here. */
  readonly anchor: number;
  readonly first: number;
  readonly last: number;
}

/** A click on a Line: selects that Line alone. */
export function selectLine({ voice, line }: LineIndex): LineSelection {
  return { voice, anchor: line, first: line, last: line };
}

/**
 * A Shift-click on a Line: the range from the anchor to that Line. A Line in
 * another Voice, or a Shift-click with nothing selected, selects that Line.
 */
export function extendSelection(
  selection: LineSelection | null,
  to: LineIndex,
): LineSelection {
  if (selection?.voice !== to.voice) return selectLine(to);
  const { anchor } = selection;
  return {
    voice: to.voice,
    anchor,
    first: Math.min(anchor, to.line),
    last: Math.max(anchor, to.line),
  };
}

/** Esc: nothing selected. */
export function clearSelection(): null {
  return null;
}
