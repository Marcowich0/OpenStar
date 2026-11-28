// The OpenStar volume as one binding (v1 spec #49): the server keeps one
// value per Stage output and tells every browser (`LiveState.volume`); a
// browser only asks for a step or a value. The Phone's Volume control and
// the Sound group's row in Options (on the Stage and on a Phone) all bind to
// it, so none holds a copy and each shows what the others set.

import { useMemo } from "react";

import type { VolumeStep } from "../generated/VolumeStep";
import type { LiveState } from "./liveState";
import type { LiveStore } from "./liveStore";
import { useLive } from "./useLive";

export interface OpenStarVolume {
  /** The Stage's volume, 0 to 100, or `null` until a Stage has told it. */
  volume: number | null;
  /** Asks the server for one step up or down (`stepVolume`). */
  step: (step: VolumeStep) => void;
  /** Asks the server to set it to `volume`, on the 5-step grid (`setVolume`). */
  set: (volume: number) => void;
}

const selectVolume = (state: LiveState) => state.volume;

export function useOpenStarVolume(store: LiveStore): OpenStarVolume {
  const volume = useLive(selectVolume, store);
  return useMemo(
    () => ({
      volume,
      step: (step) => {
        store.send({ type: "stepVolume", step });
      },
      set: (value) => {
        store.send({ type: "setVolume", volume: value });
      },
    }),
    [store, volume],
  );
}
