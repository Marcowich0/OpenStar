// What each Line-up warning's fix button does (spec #241, "Blocked Start"),
// shared by the Stage's Line-up screen and the Phone's Stage tab. Each screen
// carries the fix out its own way: the Stage opens a pick list or moves the
// focus to a field, the Phone opens the seat sheet at that field.

import type { LineUp } from "../generated/LineUp";
import type { LineUpWarning } from "../generated/LineUpWarning";
import { SEATS } from "./seats";

export type LineUpFix =
  /** Open the seat's Mic list. */
  | { kind: "pickMic"; seat: number }
  /** Go to the seat's Voice field. */
  | { kind: "pickVoice"; seat: number }
  /** Open Add a singer's Who list. */
  | { kind: "addSinger" }
  /** Open the calibration checklist with the seat's Mic ticked. */
  | { kind: "calibrate"; seat: number };

type FixKind = LineUpFix["kind"];

/**
 * The fix of each warning code (`null` for a code that has none), and
 * whether the warning blocks Start (as `LineUpWarning` documents it; the
 * server decides `canStart`, this only picks which fix a press on the greyed
 * Start goes to). Every code is named, so a new one fails `tsc` here until
 * it is decided.
 */
const WARNINGS = {
  noMic: { fix: "pickMic", blocks: true },
  micBlocked: { fix: "pickMic", blocks: false },
  localMicUnplugged: { fix: "pickMic", blocks: false },
  bridgeClosed: { fix: "pickMic", blocks: false },
  localMicSilent: { fix: "pickMic", blocks: false },
  notCalibrated: { fix: "calibrate", blocks: false },
  duetNeedsVoice: { fix: "pickVoice", blocks: true },
} as const satisfies Record<
  LineUpWarning["code"],
  { fix: FixKind | null; blocks: boolean }
>;

/** The warning codes that carry no fix button. */
export const NO_FIX: readonly LineUpWarning["code"][] = (
  Object.keys(WARNINGS) as LineUpWarning["code"][]
).filter((code) => (WARNINGS[code].fix as FixKind | null) === null);

/** Whether the warning keeps Start greyed. */
export function blocksStart(warning: LineUpWarning): boolean {
  return WARNINGS[warning.code].blocks;
}

/** A warning's fix in this Line-up, or `null` when it has none here. */
export function lineUpFix(
  warning: LineUpWarning,
  lineUp: LineUp,
): LineUpFix | null {
  if (warning.code === "duetNeedsVoice") {
    // Nobody sits on the warned Voice, so every seat is on the other one.
    // Moving the last singer fixes it when another stays behind; a lone
    // singer needs a second one.
    const last = lineUp.seats.length - 1;
    if (last >= 1) return { kind: "pickVoice", seat: last };
    return lineUp.seats.length < SEATS ? { kind: "addSinger" } : null;
  }
  const seat = lineUp.seats.findIndex(
    (s) => s.memberId === warning.params.memberId,
  );
  if (seat < 0) return null;
  switch (WARNINGS[warning.code].fix) {
    case "pickMic":
      return { kind: "pickMic", seat };
    case "calibrate":
      return lineUp.seats[seat]?.mic ? { kind: "calibrate", seat } : null;
  }
}
