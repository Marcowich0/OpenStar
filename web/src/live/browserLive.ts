import { createLiveClient, liveUrl } from "./liveClient";
import type { LiveState } from "./liveState";
import { createLiveStore, type LiveStore } from "./liveStore";

let browserStore: LiveStore | null = null;

/**
 * The browser's one live store, with its one WebSocket, made on first use and
 * shared by every route. It lives outside the route folders and imports no
 * React, so the Stage, the Phone screens and the Admin area all reach the same
 * connection.
 */
export function liveStore(): LiveStore {
  browserStore ??= createLiveStore((handlers) =>
    createLiveClient({ url: liveUrl(window.location), ...handlers }),
  );
  return browserStore;
}

/**
 * The current live state, read synchronously: no subscription and no React
 * re-render. This is what a render loop calls each frame.
 */
export function readLive(store: LiveStore = liveStore()): LiveState {
  return store.getSnapshot();
}
