// How long a Stage toast lives (v1 spec #55, "Toasts"). The live store keeps
// which toasts exist (at most `MAX_TOASTS`, oldest first, `live/toasts.ts`);
// this says what a shown toast looks like at each age.

/** The pop-in with the spring easing. */
export const TOAST_POP_IN_MS = 450;
/** How long a toast stays before it starts to leave. */
export const TOAST_STAY_MS = 4000;
/** The fade upward as it leaves. */
export const TOAST_LEAVE_MS = 350;

export type ToastPhase = "showing" | "leaving" | "gone";

/** What a toast shown `ageMs` ago is doing now. */
export function toastPhase(ageMs: number): ToastPhase {
  if (ageMs < TOAST_STAY_MS) return "showing";
  if (ageMs < TOAST_STAY_MS + TOAST_LEAVE_MS) return "leaving";
  return "gone";
}
