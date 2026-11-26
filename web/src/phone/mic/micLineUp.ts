// When a Phone is a Mic (v1 spec #50, "Phone mic lifecycle", ticket #166):
// seated in the Line-up from the tap through the Song. A Phone seated in the
// next Line-up too keeps its mic open across the change, including while the
// results of the Song it sang show (no Line-up exists then); the mic is
// released when the Phone leaves the Line-up.
//
// Listening in a Calibration (the "I'm listening" tap) is the other way to
// be a Mic; the Phone's Calibration screen adds it here when it lands.

import type { PhoneId } from "../../generated/PhoneId";
import type { LiveState } from "../../live/liveState";
import type { PhoneMic, PhoneMicState } from "./phoneMic";

/**
 * `seated`: a seat of the Line-up names this Phone. `between`: no Line-up,
 * but the results of a Song this Phone sang show (or the state is not known
 * yet), so the mic is held for the next one. `left`: release the mic.
 */
export type MicRole = "seated" | "between" | "left";

const isMe = (phoneId: PhoneId) => (mic: { kind: string } | null) =>
  mic?.kind === "phone" && "phoneId" in mic && mic.phoneId === phoneId;

export function micRole(state: LiveState, phoneId: PhoneId): MicRole {
  const party = state.stage?.party;
  if (!state.stage) return "between";
  if (!party) return "left";
  const me = isMe(phoneId);
  if (party.lineUp) {
    return party.lineUp.seats.some((seat) => me(seat.mic)) ? "seated" : "left";
  }
  return party.results?.players.some((player) => me(player.mic))
    ? "between"
    : "left";
}

/**
 * Releases `mic` whenever this Phone leaves the Line-up; returns the
 * unsubscribe.
 */
export function followLineUp(
  store: {
    getSnapshot: () => LiveState;
    subscribe: (l: () => void) => () => void;
  },
  phoneId: PhoneId,
  mic: Pick<PhoneMic, "turnOff"> & {
    getSnapshot: () => { state: PhoneMicState };
  },
): () => void {
  return store.subscribe(() => {
    if (mic.getSnapshot().state === "off") return;
    if (micRole(store.getSnapshot(), phoneId) === "left") mic.turnOff();
  });
}
