// The playing Song as a Remote shows it, in the status strip and on the Stage
// tab: its Players' names and the controls anyone may send. A control goes to
// the server, which passes it to the Stage; every Remote then hears the new
// Party state, so nothing here waits for an answer.

import { useQuery } from "@tanstack/react-query";

import { profilesQuery } from "../../api/queries";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { RequestId } from "../../generated/RequestId";
import type { SongControl } from "../../generated/SongControl";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { memberLook } from "../memberLook";

/** "Bo, Jonas": the Players' names, in the catalogue's language. */
const NAMES = new Intl.ListFormat("en", { style: "short", type: "unit" });

const selectMembers = (state: LiveState) => state.stage?.party?.members;

/** The Players' names, in seat order, as one text ("" while unknown). */
export function usePlayerNames(
  store: LiveStore,
  players: readonly PartyMemberId[],
): string {
  const members = useLive(selectMembers, store) ?? [];
  const profiles = useQuery(profilesQuery).data;
  const names = players.flatMap((memberId) => {
    const member = members.find((m) => m.memberId === memberId);
    const look = member ? memberLook(member, profiles) : null;
    return look ? [look.name] : [];
  });
  return NAMES.format(names);
}

/** Pause, Resume, Restart, Skip or End the playing Song of `requestId`. */
export function controlSong(
  store: LiveStore,
  requestId: RequestId,
  control: Exclude<SongControl, "start">,
): void {
  store.send({ type: "controlSong", requestId, control });
}
