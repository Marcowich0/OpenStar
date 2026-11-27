import type { PartyMember } from "../generated/PartyMember";
import type { PhoneId } from "../generated/PhoneId";
import type { LiveState } from "../live/liveState";

/** What the Phone page shows (v1 spec #49, "States of the Phone page"). */
export type PhonePage =
  "joinFlow" | "calibrating" | "avSync" | "micTakeover" | "remote";

/**
 * The conditions that need this Phone's id, each a pure function of the
 * store: whether a Calibrating run or Check A/V sync runs with this Phone
 * taking part, and whether this Phone is the Mic of a seat in the Line-up (or
 * shows its own Score after the Song).
 */
export interface PhonePageConditions {
  calibrating: (state: LiveState) => boolean;
  avSync: (state: LiveState) => boolean;
  micTakeover: (state: LiveState) => boolean;
}

/**
 * Whether Phone `phoneId` started the running Check A/V sync (#168): its
 * page is then the −/+ and Done; every other Remote has them on its Stage
 * tab.
 */
export function startedAvSync(state: LiveState, phoneId: PhoneId): boolean {
  return state.avSync && state.avSyncCheck.startedBy === phoneId;
}

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
  conditions: PhonePageConditions,
): PhonePage {
  if (phoneMember(state) === null) return "joinFlow";
  // Calibrate mics and Check A/V sync never run together: one slot.
  if (conditions.calibrating(state)) return "calibrating";
  if (conditions.avSync(state)) return "avSync";
  if (conditions.micTakeover(state)) return "micTakeover";
  return "remote";
}
