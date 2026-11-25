// What the Stage tab and its seat sheet read: the waiting Line-up, its Song,
// the Party members' looks and the kept Local mics.

import { useQuery } from "@tanstack/react-query";

import { localMicsQuery, profilesQuery, songQuery } from "../../api/queries";
import type { LineUp } from "../../generated/LineUp";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { memberLook, type MemberLook } from "../memberLook";

const selectParty = (state: LiveState) => state.stage?.party ?? null;

/** The Line-up waiting for Start, or `null` (none, or its Song plays). */
export function waitingLineUp(party: PartySnapshot | null): LineUp | null {
  if (!party || party.head === null || party.playing !== null) return null;
  return party.lineUp;
}

export function useLineUp(store: LiveStore) {
  const party = useLive(selectParty, store);
  const lineUp = waitingLineUp(party);
  const songId =
    party?.queue.find((r) => r.requestId === lineUp?.requestId)?.songId ?? null;
  const song = useQuery({
    ...songQuery(songId ?? 0),
    enabled: songId !== null,
  }).data;
  const profiles = useQuery(profilesQuery).data;
  const localMics = useQuery(localMicsQuery).data ?? [];
  const members = party?.members ?? [];

  const memberOf = (memberId: PartyMemberId): PartyMember | undefined =>
    members.find((m) => m.memberId === memberId);
  const lookOf = (memberId: PartyMemberId): MemberLook | null => {
    const member = memberOf(memberId);
    return member ? memberLook(member, profiles) : null;
  };
  const nameOf = (memberId: PartyMemberId) => lookOf(memberId)?.name ?? "";

  return { party, lineUp, song, localMics, members, memberOf, lookOf, nameOf };
}
