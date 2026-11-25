// The People tab's and the Me sheet's requests over the live store, each
// settled by the server's answer (`request` in `joinRequests.ts`).

import type { Difficulty } from "../../generated/Difficulty";
import type { JoinAs } from "../../generated/JoinAs";
import type { MemberEdit } from "../../generated/MemberEdit";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { UserMessage } from "../../generated/UserMessage";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { request, type JoinResult } from "../joinRequests";
import { phoneMember } from "../phonePage";

/** `null`: done, or the socket dropped before the answer came. */
export type Refusal = UserMessage | null;

const isMember = (state: LiveState, memberId: PartyMemberId) =>
  state.stage?.party?.members.some((m) => m.memberId === memberId) ?? false;

/** Removes another Party member; settles once they are gone. */
export function removeMember(
  store: LiveStore,
  memberId: PartyMemberId,
): Promise<Refusal> {
  return request<Refusal>(
    store,
    { type: "removeMember", memberId },
    (state) => (isMember(state, memberId) ? undefined : null),
    (reason) => reason,
    null,
  );
}

/** Takes this Phone's member out of the Party; settles once it is out. */
export function leaveParty(store: LiveStore): Promise<Refusal> {
  return request<Refusal>(
    store,
    { type: "leaveParty" },
    (state) => (state.phone?.leftParty ? null : undefined),
    (reason) => reason,
    null,
  );
}

/** Sets this Phone's Difficulty for the next Song. */
export function setMyDifficulty(
  store: LiveStore,
  difficulty: Difficulty,
): void {
  store.send({ type: "setMyDifficulty", difficulty });
}

/**
 * "Someone else is using this phone": this joined Phone uses `joinAs` from
 * now on, with no Join code; the previous member stays in the Party.
 * Settles once the server has told the Phone its new member.
 */
export function switchIdentity(
  store: LiveStore,
  joinAs: JoinAs,
): Promise<JoinResult> {
  const phoneBefore = store.getSnapshot().phone;
  return request<JoinResult>(
    store,
    { type: "switchIdentity", joinAs },
    (state) => {
      if (state.phone === phoneBefore) return undefined;
      const member = phoneMember(state);
      return member === null ? undefined : { ok: true, member };
    },
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}

/**
 * "Change name, look or colour": settles once the member shows the change
 * (a Profile's name and avatar come from the Profiles list, so only the
 * colour is waited for there; the event confirms the rest).
 */
export function editMember(
  store: LiveStore,
  memberId: PartyMemberId,
  edit: MemberEdit,
): Promise<Refusal> {
  const partyBefore = store.getSnapshot().stage?.party;
  return request<Refusal>(
    store,
    { type: "editMember", memberId, edit },
    (state) => (state.stage?.party !== partyBefore ? null : undefined),
    (reason) => reason,
    null,
  );
}
