// The sounds a shared control asks for (#261). The controls in `ui/` are
// used on Phones too, which never make a sound (a Phone may be a Mic), so
// they only name the sound; the Stage provides what plays it
// (`stage/sound/StageSounds.tsx`). Without a provider, as on a Phone, a cue
// does nothing, and nothing here imports the sound engine.

import { createContext, useContext } from "react";

/** What a control can ask for: a press, a refused press, a hold. */
export type UiCue = "select" | "refuse" | "holdTick" | "holdDone";

export type PlayCue = (cue: UiCue) => void;

export const UiCueContext = createContext<PlayCue | null>(null);

/** The cue player, or `null` where no sound plays (a Phone, the Admin area). */
export function useUiCue(): PlayCue | null {
  return useContext(UiCueContext);
}

/**
 * Marks a control that asks for its own sounds, so the Stage's click rule
 * (a click on a button sounds `select`) leaves it alone.
 */
export const CUES_ITSELF = { "data-ui-cue": "" } as const;
