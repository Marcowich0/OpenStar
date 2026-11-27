// The Stage tab's commands over the live store: an edit of the waiting
// Line-up, and Start. Like the Request sheet's (`requestCommands.ts`), each
// watches the store for the server's answer: the next Party state, or a
// rejection.

import type { LineUpEdit } from "../../generated/LineUpEdit";
import type { RequestId } from "../../generated/RequestId";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { request } from "../joinRequests";
import type { CommandResult } from "../songs/requestCommands";

const party = (state: LiveState) => state.stage?.party ?? null;

/**
 * Settles on the first Party state after the one the command was sent in:
 * the server answers an accepted command with `partyChanged`.
 */
function send(
  store: LiveStore,
  message: Parameters<LiveStore["send"]>[0],
): Promise<CommandResult> {
  const before = party(store.getSnapshot());
  return request<CommandResult>(
    store,
    message,
    (state) => (party(state) !== before ? { ok: true } : undefined),
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}

/** One edit of the waiting Line-up of `requestId`. */
export function editLineUp(
  store: LiveStore,
  requestId: RequestId,
  edit: LineUpEdit,
): Promise<CommandResult> {
  return send(store, { type: "editLineUp", requestId, edit });
}

/** Start: the Song of the waiting Line-up begins on the Stage. */
export function startSong(
  store: LiveStore,
  requestId: RequestId,
): Promise<CommandResult> {
  return send(store, { type: "controlSong", requestId, control: "start" });
}
