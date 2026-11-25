// The join flow's two requests over the live store. The WebSocket has no
// request ids, so each one watches the store for the server's answer: the
// next state that answers it, or the next rejection.

import type { JoinAs } from "../generated/JoinAs";
import type { JoinCode } from "../generated/JoinCode";
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
function request<T>(
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
  { ok: true } | { ok: false; reason: UserMessage | null };

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
    (state) => (phoneMember(state) === null ? undefined : { ok: true }),
    (reason) => ({ ok: false, reason }),
    { ok: false, reason: null },
  );
}
