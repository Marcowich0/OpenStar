// The Queue tab's rules (v1 spec #49, "Queue tab"; the move rules are the
// server's `live/queue.rs`): which actions a Request card's sheet offers and
// how the head is highlighted. Pure functions of the Party snapshot.

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { RequestId } from "../../generated/RequestId";

export interface RequestActions {
  playNext: boolean;
  moveUp: boolean;
  moveDown: boolean;
  changeSingers: boolean;
  /**
   * `hold`: Remove from the Queue, a press and hold. `playing`: its Song
   * plays, so only Skip or End takes it off ("It is playing now").
   */
  remove: "hold" | "playing";
}

/**
 * What the sheet of Request `requestId` offers, or `null` when it is not in
 * the Queue. Nothing moves above the head and the head itself never moves,
 * so with a head Play next and Move up are for the places below the second;
 * while the results show there is no head and only the first place is the
 * top. Move down is for any Request except the head and the last.
 */
export function requestActions(
  party: PartySnapshot,
  requestId: RequestId,
): RequestActions | null {
  const place = party.queue.findIndex((r) => r.requestId === requestId);
  if (place === -1) return null;
  const isHead = party.head === requestId;
  // The highest place a Request other than the head may take.
  const top = party.head === null ? 0 : 1;
  const climbs = !isHead && place > top;
  return {
    playNext: climbs,
    moveUp: climbs,
    moveDown: !isHead && place < party.queue.length - 1,
    changeSingers: true,
    remove: party.playing?.requestId === requestId ? "playing" : "hold",
  };
}

/** How a card is highlighted: the head is up next, or playing now. */
export function headState(
  party: PartySnapshot,
  requestId: RequestId,
): "upNext" | "playing" | null {
  if (party.head !== requestId) return null;
  return party.playing?.requestId === requestId ? "playing" : "upNext";
}
