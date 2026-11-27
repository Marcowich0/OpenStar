// The join flow's two requests over the live store. The WebSocket has no
// request ids, so each one watches the store for the server's answer: the
// next state that answers it, or the next rejection.

import type { JoinAs } from "../generated/JoinAs";
import type { JoinCode } from "../generated/JoinCode";
import type { PaletteKey } from "../generated/PaletteKey";
import type { PartyMember } from "../generated/PartyMember";
import type { PartyMemberId } from "../generated/PartyMemberId";
import type { PhoneId } from "../generated/PhoneId";
import type { UserMessage } from "../generated/UserMessage";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { phoneMember } from "./phonePage";

/** "unanswered": the socket was closed or dropped before the answer came. */
export type CodeAnswer = "accepted" | "refused" | "unanswered";

/**
 * Sends `message` and settles with the first state `answer` turns into a
 * result. A rejection that arrives meanwhile is the server's answer too, and
 * a dropped socket ends the wait.
 */
export function request<T>(
  store: LiveStore,
  message: Parameters<LiveStore["send"]>[0],
  answer: (state: LiveState) => T | undefined,
  rejected: (reason: UserMessage) => T,
  unanswered: T,
): Promise<T> {
  return new Promise((resolve) => {
    const rejectionBefore = store.getSnapshot().lastRejection;
    const unsubscribe = store.subscribe(() => {
      const state = store.getSnapshot();
      let result: T | undefined;
      if (state.lastRejection !== rejectionBefore && state.lastRejection)
        result = rejected(state.lastRejection);
      else if (state.connection !== "open") result = unanswered;
      else result = answer(state);
      if (result === undefined) return;
      unsubscribe();
      resolve(result);
    });
    if (!store.send(message)) {
      unsubscribe();
      resolve(unanswered);
    }
  });
}

/** Asks the server whether `joinCode` is the current Party's Join code. */
export function checkJoinCode(
  store: LiveStore,
  joinCode: JoinCode,
): Promise<CodeAnswer> {
  return request<CodeAnswer>(
    store,
    { type: "checkJoinCode", joinCode },
    (state) => (state.validJoinCode === joinCode ? "accepted" : undefined),
    (reason) => (reason.code === "joinCodeWrong" ? "refused" : "unanswered"),
    "unanswered",
  );
}

export type JoinResult =
  { ok: true; member: PartyMember } | { ok: false; reason: UserMessage | null };

/**
 * Joins this Phone to the current Party. Succeeds once the server says the
 * Phone uses a member of the Party; `reason` is `null` when the socket
 * dropped first.
 */
export function joinParty(
  store: LiveStore,
  join: { phoneId: PhoneId; joinCode: JoinCode; joinAs: JoinAs },
): Promise<JoinResult> {
  return request<JoinResult>(
    store,
    { type: "join", ...join },
    (state) => {
      const member = phoneMember(state);
      return member === null ? undefined : { ok: true, member };
    },
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}

export type EditResult =
  { ok: true } | { ok: false; reason: UserMessage | null };

/**
 * Gives a Party member another colour (for a Profile it becomes its
 * favourite too). Succeeds once the member has it.
 */
export function editMemberColour(
  store: LiveStore,
  memberId: PartyMemberId,
  colour: PaletteKey,
): Promise<EditResult> {
  return request<EditResult>(
    store,
    { type: "editMember", memberId, edit: { colour } },
    (state) =>
      state.stage?.party?.members.some(
        (m) => m.memberId === memberId && m.colour === colour,
      )
        ? { ok: true }
        : undefined,
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}
