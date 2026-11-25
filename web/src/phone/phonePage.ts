import type { PartyMember } from "../generated/PartyMember";
import type { LiveState } from "../live/liveState";

/** What the Phone page shows (v1 spec #49, "States of the Phone page"). */
export type PhonePage = "joinFlow" | "calibrating" | "micTakeover" | "remote";

/**
 * The conditions later tickets fill in, each a pure function of the store:
 * whether a Calibrating run or Check A/V sync runs with this Phone taking
 * part, and whether this Phone is the Mic of a seat in the Line-up (or shows
 * its own Score after the Song).
 */
export interface PhonePageConditions {
  calibrating: (state: LiveState) => boolean;
  micTakeover: (state: LiveState) => boolean;
}

/** Neither is modelled in the store yet. */
const STORE_CONDITIONS: PhonePageConditions = {
  calibrating: () => false,
  micTakeover: () => false,
};

/**
 * The Party member this Phone uses, or `null` while it has not joined the
 * current Party (or the server has not answered its Phone id yet).
 */
export function phoneMember(state: LiveState): PartyMember | null {
  const memberId = state.phone?.memberId;
  if (memberId === undefined || memberId === null) return null;
  return (
    state.stage?.party?.members.find((m) => m.memberId === memberId) ?? null
  );
}

/**
 * The Phone page's state, in order of precedence: the join flow, then
 * Calibrating or Check A/V sync, then the mic takeover, then the Remote.
 */
export function phonePage(
  state: LiveState,
  conditions: PhonePageConditions = STORE_CONDITIONS,
): PhonePage {
  if (phoneMember(state) === null) return "joinFlow";
  if (conditions.calibrating(state)) return "calibrating";
  if (conditions.micTakeover(state)) return "micTakeover";
  return "remote";
}
