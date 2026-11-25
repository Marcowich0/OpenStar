// OpenStar's own number pad, never the phone keyboard (v1 spec #49). One
// component, two forms:
// - the Join code: four boxes, submitted as soon as the fourth digit is
//   typed, with no OK key;
// - the Admin PIN: 4 to 8 digits shown as dots, submitted only on OK
//   (v1 spec #45). Checking the PIN, the lockout and the Unlock are the
//   Admin area's; the pad only submits and shows the caller's message.
//
// This is the pure entry state; `NumberPad` draws it and feeds it keys.

export type PadForm = "joinCode" | "adminPin";

export const JOIN_CODE_LENGTH = 4;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

export interface PadState {
  /** The digits typed so far. */
  digits: string;
  /** Submitted, waiting for the caller's answer: keys do nothing. */
  pending: boolean;
  /** The last submit was refused (the entry was cleared for a new try). */
  refused: boolean;
}

export const EMPTY_PAD: PadState = {
  digits: "",
  pending: false,
  refused: false,
};

export type PadAction =
  | { type: "digit"; digit: string }
  | { type: "delete" }
  | { type: "ok" }
  /** The caller refused the submitted entry. */
  | { type: "refused" }
  /** The caller took the submitted entry. */
  | { type: "accepted" };

export interface PadStep {
  state: PadState;
  /** The entry to hand to the caller now, if any. */
  submit: string | null;
}

/** The most digits the form takes. */
export function maxLength(form: PadForm): number {
  return form === "joinCode" ? JOIN_CODE_LENGTH : PIN_MAX_LENGTH;
}

export function padStep(
  form: PadForm,
  state: PadState,
  action: PadAction,
): PadStep {
  const stay = { state, submit: null };
  switch (action.type) {
    case "refused":
      return {
        state: { digits: "", pending: false, refused: true },
        submit: null,
      };
    case "accepted":
      return { state: { ...state, pending: false }, submit: null };
    case "digit": {
      if (state.pending || !/^[0-9]$/.test(action.digit)) return stay;
      if (state.digits.length >= maxLength(form)) return stay;
      const digits = state.digits + action.digit;
      const complete =
        form === "joinCode" && digits.length === JOIN_CODE_LENGTH;
      return {
        state: { digits, pending: complete, refused: false },
        submit: complete ? digits : null,
      };
    }
    case "delete":
      if (state.pending) return stay;
      return {
        state: {
          digits: state.digits.slice(0, -1),
          pending: false,
          refused: false,
        },
        submit: null,
      };
    case "ok":
      if (
        form !== "adminPin" ||
        state.pending ||
        state.digits.length < PIN_MIN_LENGTH
      )
        return stay;
      return { state: { ...state, pending: true }, submit: state.digits };
  }
}
