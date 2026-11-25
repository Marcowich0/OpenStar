// The Remote frame's rules (v1 spec #49, "The Remote frame"): which tab the
// Remote opens on, when the status strip shows above the tabs, and the
// Queue tab's badge. Pure functions of the Party snapshot.

import type { PartySnapshot } from "../generated/PartySnapshot";
import type { SongId } from "../generated/SongId";

/** The Remote's four tabs, in order. */
export const REMOTE_TABS = ["songs", "queue", "stage", "people"] as const;
export type RemoteTab = (typeof REMOTE_TABS)[number];

/** The Song of the head whose Line-up waits for Start, if one does. */
function waitingLineUp(party: PartySnapshot | null): SongId | null {
  if (!party || party.head === null || party.lineUp === null) return null;
  const head = party.queue.find((r) => r.requestId === party.head);
  return head ? head.songId : null;
}

/** The Stage tab whenever a Line-up waits, Songs otherwise. */
export function defaultTab(party: PartySnapshot | null): RemoteTab {
  return waitingLineUp(party) === null ? "songs" : "stage";
}

/**
 * What the status strip shows, or `null` when it is hidden: never on the
 * Stage tab. While a Line-up waits it shows "Line-up for <Song>". The playing
 * Song (with Pause/Resume) is #160's.
 */
export type StatusStrip = { kind: "lineUp"; songId: SongId };

export function statusStrip(
  party: PartySnapshot | null,
  tab: RemoteTab,
): StatusStrip | null {
  if (tab === "stage") return null;
  const songId = waitingLineUp(party);
  return songId === null ? null : { kind: "lineUp", songId };
}

/** The Queue tab's badge: how many Requests the Queue holds. */
export function queueCount(party: PartySnapshot | null): number {
  return party?.queue.length ?? 0;
}
