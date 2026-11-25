import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ChangeTopic } from "../generated/ChangeTopic";
import { liveStore } from "./browserLive";
import type { LiveState } from "./liveState";
import type { LiveStore } from "./liveStore";

export { liveStore, readLive } from "./browserLive";

/**
 * One slice of the live state. The component re-renders only when the slice
 * changes (compared with `Object.is`), so `select` must return a part of the
 * state (the reducer keeps unchanged parts by reference), never a new object
 * or array built on each call. Keep `select` stable (module level or
 * `useCallback`).
 */
export function useLive<T>(
  select: (state: LiveState) => T,
  store: LiveStore = liveStore(),
): T {
  const getSlice = useCallback(
    () => select(store.getSnapshot()),
    [select, store],
  );
  return useSyncExternalStore(store.subscribe, getSlice);
}

/** The whole live state; re-renders on every change. */
export function useLiveState(store: LiveStore = liveStore()): LiveState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Calls `listener` (keep it stable) whenever a change notice names `topic`. */
export function useChangeNotice(
  topic: ChangeTopic,
  listener: () => void,
  store: LiveStore = liveStore(),
): void {
  useEffect(() => store.onChanged(topic, listener), [store, topic, listener]);
}
