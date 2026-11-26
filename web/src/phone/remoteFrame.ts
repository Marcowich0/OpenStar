// The Remote frame's rules (v1 spec #49, "The Remote frame"): which tab the
// Remote opens on, what the Stage is doing (one Stage tab card per state),
// when the status strip shows above the tabs, and the Queue tab's badge. Pure functions of the Party snapshot.

import type { PartyMemberId } from "../generated/PartyMemberId";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { RequestId } from "../generated/RequestId";
import type { SongId } from "../generated/SongId";

/** The Remote's four tabs, in order. */
export const REMOTE_TABS = ["songs", "queue", "stage", "people"] as const;
export type RemoteTab = (typeof REMOTE_TABS)[number];

/**
 * What the Stage is doing, as the Stage tab shows it in one card per state
 * (v1 spec #49, "Stage tab"), in the Party's precedence: results, then the
 * playing (or paused) Song, then the waiting Line-up, then the empty Queue.
 * `null` before the Party is known, or for a moment between states.
 */
export type StageState =
  | {
      kind: "results";
      songId: SongId;
      /** The Queue holds nothing more: "Done" instead of "Next Song". */
      queueEmpty: boolean;
    }
  | {
      kind: "playing";
      requestId: RequestId;
      songId: SongId;
      paused: boolean;
      /** The Players, in seat order. */
      players: PartyMemberId[];
    }
  | { kind: "lineUp"; songId: SongId }
  | { kind: "empty" };

export function stageState(party: PartySnapshot | null): StageState | null {
  if (!party) return null;
  if (party.results) {
    return {
      kind: "results",
      songId: party.results.songId,
      queueEmpty: party.queue.length === 0,
    };
  }
  if (party.playing) {
    return {
      kind: "playing",
      requestId: party.playing.requestId,
      songId: party.playing.songId,
      paused: party.playing.paused,
      players: party.lineUp?.seats.map((seat) => seat.memberId) ?? [],
    };
  }
  if (party.head !== null && party.lineUp !== null) {
    const head = party.queue.find((r) => r.requestId === party.head);
    if (head) return { kind: "lineUp", songId: head.songId };
  }
  return party.queue.length === 0 ? { kind: "empty" } : null;
}

/** The Stage tab whenever a Line-up waits, Songs otherwise. */
export function defaultTab(party: PartySnapshot | null): RemoteTab {
  return stageState(party)?.kind === "lineUp" ? "stage" : "songs";
}

/**
 * What the status strip shows, or `null` when it is hidden: never on the
 * Stage tab. While a Song plays or is paused: its cover, title and Players,
 * with a round Pause/Resume. While a Line-up waits: "Line-up for <Song>".
 */
export type StatusStrip = Extract<StageState, { kind: "playing" | "lineUp" }>;

export function statusStrip(
  party: PartySnapshot | null,
  tab: RemoteTab,
): StatusStrip | null {
  if (tab === "stage") return null;
  const state = stageState(party);
  return state?.kind === "playing" || state?.kind === "lineUp" ? state : null;
}

/** The Queue tab's badge: how many Requests the Queue holds. */
export function queueCount(party: PartySnapshot | null): number {
  return party?.queue.length ?? 0;
}
