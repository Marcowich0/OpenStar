import { createLiveClient, liveUrl } from "./liveClient";
import type { LiveState } from "./liveState";
import { createLiveStore, type LiveStore } from "./liveStore";
import { phoneId, type PhoneStorage } from "./phoneId";

let browserStore: LiveStore | null = null;

/**
 * The browser's one live store, with its one WebSocket, made on first use and
 * shared by every route. It lives outside the route folders and imports no
 * React, so the Stage, the Phone screens and the Admin area all reach the same
 * connection.
 */
export function liveStore(): LiveStore {
  browserStore ??= createLiveStore(
    (handlers) =>
      createLiveClient({ url: liveUrl(window.location), ...handlers }),
    () => ({ type: "hello", phoneId: phoneId(browserStorage()) }),
  );
  return browserStore;
}

/** The browser's local storage; reading it can throw when it is blocked. */
function browserStorage(): PhoneStorage {
  try {
    return window.localStorage;
  } catch {
    return blockedStorage;
  }
}

const blockedStorage: PhoneStorage = {
  getItem: () => {
    throw new Error("local storage is blocked");
  },
  setItem: () => {
    throw new Error("local storage is blocked");
  },
  removeItem: () => {
    throw new Error("local storage is blocked");
  },
};

/**
 * The current live state, read synchronously: no subscription and no React
 * re-render. This is what a render loop calls each frame.
 */
export function readLive(store: LiveStore = liveStore()): LiveState {
  return store.getSnapshot();
}
