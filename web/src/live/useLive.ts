import { useEffect, useSyncExternalStore } from "react";

import type { ChangeTopic } from "../generated/ChangeTopic";
import { createLiveClient, liveUrl } from "./liveClient";
import type { LiveState } from "./liveState";
import { createLiveStore, type LiveStore } from "./liveStore";

let browserStore: LiveStore | null = null;

/** The browser's one live store, with its one WebSocket, made on first use. */
export function liveStore(): LiveStore {
  browserStore ??= createLiveStore((handlers) =>
    createLiveClient({ url: liveUrl(window.location), ...handlers }),
  );
  return browserStore;
}

/** The live state; re-renders when it changes. */
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
