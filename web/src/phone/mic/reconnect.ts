// When the live store's WebSocket is open again after a drop (#129). The
// store presents the Phone id on every open before telling its subscribers,
// so by the time a listener runs the server knows this Phone again.

import type { LiveStore } from "../../live/liveStore";

/**
 * Calls `listener` each time the connection is open again after it was lost
 * (never on the first open); returns the unsubscribe.
 */
export function onReconnect(
  store: Pick<LiveStore, "getSnapshot" | "subscribe">,
  listener: () => void,
): () => void {
  let connection = store.getSnapshot().connection;
  let dropped = false;
  return store.subscribe(() => {
    const next = store.getSnapshot().connection;
    if (next === connection) return;
    connection = next;
    if (next === "reconnecting") dropped = true;
    if (next === "open" && dropped) {
      dropped = false;
      listener();
    }
  });
}
