// The Queue tab's commands over the live store. Like the Request sheet's
// (`songs/requestCommands.ts`), each settles on the server's answer: the
// Party state that shows the change, or a rejection.

import type { QueueMove } from "../../generated/QueueMove";
import type { RequestId } from "../../generated/RequestId";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { request } from "../joinRequests";
import type { CommandResult } from "../songs/requestCommands";

/** Request `requestId`'s place in the Queue, `-1` when it is not there. */
const placeOf = (state: LiveState, requestId: RequestId) =>
  state.stage?.party?.queue.findIndex((r) => r.requestId === requestId) ?? -1;

/** Play next, Move up or Move down; done once the Request has moved. */
export function moveRequest(
  store: LiveStore,
  requestId: RequestId,
  to: QueueMove,
): Promise<CommandResult> {
  const before = placeOf(store.getSnapshot(), requestId);
  return request<CommandResult>(
    store,
    { type: "moveRequest", requestId, to },
    (state) => {
      const place = placeOf(state, requestId);
      if (place === -1)
        return { ok: false, reason: { code: "requestNotFound" } };
      return place === before ? undefined : { ok: true };
    },
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}

/** Remove from the Queue; done once the Request has left it. */
export function removeRequest(
  store: LiveStore,
  requestId: RequestId,
): Promise<CommandResult> {
  return request<CommandResult>(
    store,
    { type: "removeRequest", requestId },
    (state) => (placeOf(state, requestId) === -1 ? { ok: true } : undefined),
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}
