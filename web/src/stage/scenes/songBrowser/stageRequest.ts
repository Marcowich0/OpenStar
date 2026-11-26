// Sing! on the Stage: a Request from the Stage, which names no Players and
// has no adder. Like the Phone's commands (`phone/songs/requestCommands.ts`),
// it watches the store for the server's answer.

import type { SongId } from "../../../generated/SongId";
import type { LiveStore } from "../../../live/liveStore";
import type { CommandResult } from "../../../phone/songs/requestCommands";
import { request } from "../../../phone/joinRequests";

/** Adds `songId` to the end of the Queue as a Request from the Stage. */
export function addStageRequest(
  store: LiveStore,
  songId: SongId,
): Promise<CommandResult> {
  const before = store.getSnapshot().stage?.party?.queue ?? [];
  const newest = Math.max(0, ...before.map((r) => r.requestId));
  return request<CommandResult>(
    store,
    { type: "addRequest", songId, requestedPlayers: null },
    (state) =>
      state.stage?.party?.queue.some(
        (r) => r.requestId > newest && r.songId === songId && r.adder === null,
      )
        ? { ok: true }
        : undefined,
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}
