// Which Song plays on the Stage now, from the live state (#225). While a
// Song plays, its timing can't be fixed: Fit to the singing, the Timing
// editor's Save and Restore Original are disabled for it (the server refuses
// them as well). It follows the live state, so the disabled state updates
// when the Song starts or stops without a reload.

import type { SongId } from "../generated/SongId";
import type { LiveState } from "./liveState";
import type { LiveStore } from "./liveStore";
import { useLive } from "./useLive";

/** The Song playing on the Stage now, or `null`. */
export function playingSong(state: LiveState): SongId | null {
  return state.stage?.party?.playing?.songId ?? null;
}

/**
 * Whether Song `song` plays on the Stage now; re-renders when that changes.
 * `store` defaults to the browser's live store.
 */
export function useSongPlaying(
  song: SongId,
  store?: Pick<LiveStore, "subscribe" | "getSnapshot">,
): boolean {
  return useLive(playingSong, store as LiveStore | undefined) === song;
}
