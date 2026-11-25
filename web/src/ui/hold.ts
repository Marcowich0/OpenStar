// Press and hold: the one pattern for destructive actions any Remote may take
// (Restart, Skip, End, removing a Request or a Party member), and on the Stage
// the same actions plus New party and taking the Stage back (v1 spec #49,
// #55). No confirmation sheet and no Undo toast: the hold is the confirmation.
//
// This is the pure timing; `HoldButton` drives it with pointer and Enter key
// events and one timer.

/** How long a hold takes to fire. Every hold-to-confirm control uses it. */
export const HOLD_DURATION_MS = 700;

export type HoldState =
  | { phase: "idle" }
  | { phase: "holding"; /** When the press began, in ms. */ since: number };

export const IDLE: HoldState = { phase: "idle" };

export type HoldEvent =
  /** Pointer down, or Enter key down. */
  | { type: "press"; at: number }
  /** Pointer up, or Enter key up. */
  | { type: "release"; at: number }
  /** The pointer left the button, or the press was cancelled. */
  | { type: "leave" }
  /** The timer: time has passed. */
  | { type: "tick"; at: number };

export interface HoldStep {
  state: HoldState;
  /** Run the action now. True at most once per press. */
  fire: boolean;
  /** Show "Hold for a moment": the press ended too early. */
  hint: boolean;
}

export function holdStep(state: HoldState, event: HoldEvent): HoldStep {
  const stay = { state, fire: false, hint: false };
  const complete =
    state.phase === "holding" &&
    "at" in event &&
    event.at - state.since >= HOLD_DURATION_MS;
  switch (event.type) {
    case "press":
      return state.phase === "idle"
        ? {
            state: { phase: "holding", since: event.at },
            fire: false,
            hint: false,
          }
        : stay;
    case "tick":
      return complete ? { state: IDLE, fire: true, hint: false } : stay;
    case "release":
      if (complete) return { state: IDLE, fire: true, hint: false };
      return state.phase === "holding"
        ? { state: IDLE, fire: false, hint: true }
        : stay;
    case "leave":
      return { state: IDLE, fire: false, hint: false };
  }
}
