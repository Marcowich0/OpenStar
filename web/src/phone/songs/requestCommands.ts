// The Request sheet's two commands over the live store. Like the join flow's
// (`joinRequests.ts`), each watches the store for the server's answer: the
// Party state that shows the change, or a rejection.

import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { RequestId } from "../../generated/RequestId";
import type { SongId } from "../../generated/SongId";
import type { UserMessage } from "../../generated/UserMessage";
import type { LiveStore } from "../../live/liveStore";
import { request } from "../joinRequests";

/** `reason` is `null` when the socket dropped before the answer. */
export type CommandResult =
  { ok: true } | { ok: false; reason: UserMessage | null };

const refused = (reason: UserMessage): CommandResult => ({
  ok: false,
  reason,
});
const unanswered: CommandResult = { ok: false, reason: null };

/**
 * Adds a Request for `songId` with `requestedPlayers` at the end of the
 * Queue; the server makes this Phone's member its adder. Succeeds once the
 * Queue holds a new Request of `me` for the Song (Request ids only grow).
 */
export function addRequest(
  store: LiveStore,
  songId: SongId,
  requestedPlayers: PartyMemberId[],
  me: PartyMemberId,
): Promise<CommandResult> {
  const before = store.getSnapshot().stage?.party?.queue ?? [];
  const newest = Math.max(0, ...before.map((r) => r.requestId));
  return request<CommandResult>(
    store,
    { type: "addRequest", songId, requestedPlayers },
    (state) =>
      state.stage?.party?.queue.some(
        (r) => r.requestId > newest && r.songId === songId && r.adder === me,
      )
        ? { ok: true }
        : undefined,
    refused,
    unanswered,
  );
}

/** Changes an existing Request's requested Players. */
export function setRequestedPlayers(
  store: LiveStore,
  requestId: RequestId,
  requestedPlayers: PartyMemberId[],
): Promise<CommandResult> {
  return request<CommandResult>(
    store,
    { type: "setRequestedPlayers", requestId, requestedPlayers },
    (state) => {
      const changed = state.stage?.party?.queue.find(
        (r) => r.requestId === requestId,
      );
      if (!changed) return refused({ code: "requestNotFound" });
      return sameSingers(changed.requestedPlayers, requestedPlayers)
        ? { ok: true }
        : undefined;
    },
    refused,
    unanswered,
  );
}

export function sameSingers(
  a: readonly PartyMemberId[],
  b: readonly PartyMemberId[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
