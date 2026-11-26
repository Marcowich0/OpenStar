// Toast entries: the Party change events a browser shows as toasts.
//
// The reducer (`liveState.ts`) turns each `partyChanged` message into a toast
// entry carrying the event's code, parameters and actor. The Stage keeps
// entries only for changes made from a Remote or the Admin area (a deletion,
// a Song gone at a Rescan: these always toast); every other browser (a Phone,
// or a former Stage after the Stage moved) keeps them for changes from any
// Remote or the Stage. Drawing them (ink pills) is the Stage and Phone
// screens' job: render the text with `toastContent` (`toasts/`), and call
// `dismissToast` when one has been shown. The Stage also raises a few toasts
// itself (`addStageToast`), for what only it can tell.

import type { Actor } from "../generated/Actor";
import type { ChangeEvent } from "../generated/ChangeEvent";
import type { PartyEvent } from "../generated/PartyEvent";
import type { PartyMemberId } from "../generated/PartyMemberId";
import type { LiveState } from "./liveState";

/** At most this many toasts are kept; a new one pushes out the oldest. */
export const MAX_TOASTS = 3;

/**
 * A toast the Stage raises itself, for what only the Stage can tell (the
 * lost-Mic rule runs on the Stage). A code plus parameters like a
 * `PartyEvent`, made in the frontend, so no English is stored.
 */
export type StageToastEvent = {
  /** "Mia is back on the mic": a seat's lost Mic came back during a Song. */
  code: "backOnMic";
  /** `name` is the member's name at Start, for when they have left since. */
  params: { memberId: PartyMemberId; name: string };
};

/** One Party change (or Stage-made notice) to show as a toast. */
export interface Toast {
  /** Unique within this browser's store, rising with each toast. */
  id: number;
  actor: Actor;
  event: PartyEvent | StageToastEvent;
}

function pushToast(
  state: Pick<LiveState, "toasts" | "nextToastId">,
  actor: Actor,
  event: Toast["event"],
): Pick<LiveState, "toasts" | "nextToastId"> {
  const toast: Toast = { id: state.nextToastId, actor, event };
  return {
    toasts: [...state.toasts, toast].slice(-MAX_TOASTS),
    nextToastId: state.nextToastId + 1,
  };
}

/** Adds a toast the Stage raised itself; it is about the member it names. */
export function addStageToast(
  state: Pick<LiveState, "toasts" | "nextToastId">,
  event: StageToastEvent,
): Pick<LiveState, "toasts" | "nextToastId"> {
  return pushToast(
    state,
    { kind: "member", memberId: event.params.memberId },
    event,
  );
}

/** Whether a change gets a toast in this browser. */
export function toastsFor(isStage: boolean, change: ChangeEvent): boolean {
  // The Local mic list changing (plugged in, a bridge closed) is shown by
  // the Mic lists themselves.
  if (change.event.code === "localMicsChanged") return false;
  return !(isStage && change.actor.kind === "stage");
}

/** Adds the toast for an accepted change, if this browser shows one. */
export function addToast(
  state: LiveState,
  isStage: boolean,
  change: ChangeEvent,
): Pick<LiveState, "toasts" | "nextToastId"> {
  if (!toastsFor(isStage, change)) {
    return { toasts: state.toasts, nextToastId: state.nextToastId };
  }
  return pushToast(state, change.actor, change.event);
}

/** Drops the toast with this id; the state stays the same object if none has it. */
export function dismissToast(state: LiveState, id: number): LiveState {
  return state.toasts.some((toast) => toast.id === id)
    ? { ...state, toasts: state.toasts.filter((toast) => toast.id !== id) }
    : state;
}
