/**
 * Auto-fit as a Timing edit (v1 spec #57): Fit to the singing (`#GAP` and
 * `#BPM` together) or offset only (`#GAP`, keeping `#BPM`), run on the
 * current timing with the fit module. A fit is one undoable edit, described
 * in plain words (`fit/describeFit.ts`), followed by the Lines still off.
 * Pure: the desktop editor commits the edit; a Phone can use it the same way.
 */

import { describeFit, type FitDescription } from "../fit/describeFit";
import { fitNotesOf, type LineSuggestion, type Matcher } from "../fit/fit";
import { round2 } from "./songEdits";
import {
  commit,
  currentTiming,
  type TimingEdit,
  type TimingModel,
} from "./timingModel";

export type AutoFit =
  | {
      /** The search found nothing better: nothing is applied. */
      readonly kind: "alreadyBest";
      /** The Lines still off on the current timing. */
      readonly suggestions: LineSuggestion[];
    }
  | {
      readonly kind: "fitted";
      readonly edit: TimingEdit;
      readonly description: Extract<FitDescription, { kind: "fitted" }>;
      /** The Lines still off once the fit is applied. */
      readonly suggestions: LineSuggestion[];
    };

/** Runs the fit search on the model's current timing. */
export function autoFit(
  model: TimingModel,
  matcher: Matcher,
  { tempo }: { tempo: boolean },
): AutoFit {
  const timing = currentTiming(model);
  const notes = fitNotesOf(timing.song);
  const fit = matcher.fitToTheSinging(notes, timing.grid, { tempo });
  const toGapMs = Math.round(fit.gapSeconds * 1000);
  const toBpm = tempo ? round2(fit.beatsPerMinute / 4) : timing.bpm;
  const description = describeFit(
    {
      gapMs: timing.gapMs,
      bpm: timing.bpm,
      share: matcher.share(notes, timing.grid),
    },
    { gapMs: toGapMs, bpm: toBpm, share: fit.share },
  );
  if (description.kind === "alreadyBest") {
    return {
      kind: "alreadyBest",
      suggestions: matcher.lineSuggestions(notes, timing.grid),
    };
  }
  const edit: TimingEdit = {
    operations: [
      { op: "setGap", seconds: toGapMs / 1000 },
      ...(tempo ? [{ op: "setBpm" as const, beatsPerMinute: toBpm * 4 }] : []),
    ],
    description: tempo
      ? {
          kind: "fitToTheSinging",
          fromGapMs: timing.gapMs,
          toGapMs,
          fromBpm: timing.bpm,
          toBpm,
        }
      : { kind: "fitOffsetOnly", fromGapMs: timing.gapMs, toGapMs },
  };
  const after = currentTiming(commit(model, edit, 0));
  return {
    kind: "fitted",
    edit,
    description,
    suggestions: matcher.lineSuggestions(fitNotesOf(after.song), after.grid),
  };
}
