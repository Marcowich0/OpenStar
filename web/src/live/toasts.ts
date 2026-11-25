// Toast entries: the Party change events a browser shows as toasts.
//
// The reducer (`liveState.ts`) turns each `partyChanged` message into a toast
// entry carrying the event's code, parameters and actor. The Stage keeps
// entries only for changes made from a Remote; every other browser (a Phone,
// or a former Stage after the Stage moved) keeps them for changes from any
// Remote or the Stage. Drawing them (ink pills) is the Stage and Phone
// screens' job: render the text with `partyEventText(toast.event)` from
// `i18n/serverText.ts`, and call `dismissToast` when one has been shown.

import type { Actor } from "../generated/Actor";
import type { ChangeEvent } from "../generated/ChangeEvent";
import type { PartyEvent } from "../generated/PartyEvent";
import type { LiveState } from "./liveState";

/** At most this many toasts are kept; a new one pushes out the oldest. */
export const MAX_TOASTS = 3;

/** One Party change to show as a toast. */
export interface Toast {
  /** Unique within this browser's store, rising with each toast. */
  id: number;
  actor: Actor;
  event: PartyEvent;
}

/** Whether a change gets a toast in this browser. */
export function toastsFor(isStage: boolean, change: ChangeEvent): boolean {
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
  const toast: Toast = {
    id: state.nextToastId,
    actor: change.actor,
    event: change.event,
  };
  return {
    toasts: [...state.toasts, toast].slice(-MAX_TOASTS),
    nextToastId: state.nextToastId + 1,
  };
}

/** Drops the toast with this id; the state stays the same object if none has it. */
export function dismissToast(state: LiveState, id: number): LiveState {
  return state.toasts.some((toast) => toast.id === id)
    ? { ...state, toasts: state.toasts.filter((toast) => toast.id !== id) }
    : state;
}
