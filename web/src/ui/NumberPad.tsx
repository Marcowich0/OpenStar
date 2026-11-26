// OpenStar's own large number pad, never the phone keyboard (v1 spec #49).
//
// - `form="joinCode"`: four large boxes above a 3 × 4 grid (1–9, a blank,
//   0, delete). The next box to fill is marked. The code goes to `onSubmit`
//   as soon as the fourth digit is typed; there is no OK key. A refused code
//   shakes the boxes, says "That code is not on the Stage" and clears.
// - `form="adminPin"` (v1 spec #45): a lock icon, the heading "Admin PIN",
//   the digits as dots and an OK key. 4 to 8 digits, sent only on OK.
//   Checking the PIN, the lockout countdown and the Unlock are the caller's;
//   it shows its own text through `message` and stops all keys with
//   `locked` while the wrong-guess wait runs (`pin/AdminPinDialog.tsx`).
//
// `onSubmit` answers "refused" (the pad clears and shakes for a new try) or
// anything else (the pad takes keys again). Digits, Backspace and Enter on a
// hardware keyboard work too, unless a text field has the focus.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { t } from "../i18n/t";
import { Button } from "./Button";
import { Icon } from "./Icon";
import {
  EMPTY_PAD,
  JOIN_CODE_LENGTH,
  PIN_MIN_LENGTH,
  maxLength,
  padStep,
  type PadAction,
  type PadForm,
} from "./numberPad";
import { isFormField } from "./formField";

export type PadAnswer = "refused" | "accepted";

export interface NumberPadProps {
  form: PadForm;
  /** The entry, when complete. Answer "refused" to clear it for a new try. */
  onSubmit: (
    entry: string,
  ) => PadAnswer | undefined | Promise<PadAnswer | undefined>;
  /** The caller's own text under the entry (a wrong PIN, the lockout). */
  message?: string | undefined;
  /** Takes no keys at all (the Admin PIN wait): digits, delete and OK do nothing. */
  locked?: boolean;
  className?: string;
}

const KEY_CLASSES =
  "flex h-16 items-center justify-center rounded-full bg-white text-3xl font-semibold text-ink shadow-ledge-sm outline-none cursor-pointer select-none transition-transform duration-150 active:translate-y-1 focus-visible:outline-6 focus-visible:outline-yellow";

/** The 3 × 4 grid, row by row: 1–9, a blank, 0 and delete. */
const GRID = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  null,
  "0",
  "delete",
] as const;

export function NumberPad({
  form,
  onSubmit,
  message,
  locked = false,
  className = "",
}: NumberPadProps) {
  const [pad, setPad] = useState(EMPTY_PAD);
  const padRef = useRef(EMPTY_PAD);
  // Bumped on every refusal, so the shake restarts each time.
  const [refusals, setRefusals] = useState(0);
  const [shaking, setShaking] = useState(false);
  const mounted = useRef(true);
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  function dispatch(action: PadAction) {
    if (
      lockedRef.current &&
      (action.type === "digit" ||
        action.type === "delete" ||
        action.type === "ok")
    )
      return;
    const step = padStep(form, padRef.current, action);
    padRef.current = step.state;
    setPad(step.state);
    if (action.type === "refused") {
      setRefusals((n) => n + 1);
      setShaking(true);
    }
    if (step.submit === null) return;
    const answer = (value: PadAnswer | undefined) => {
      if (mounted.current)
        dispatch({ type: value === "refused" ? "refused" : "accepted" });
    };
    Promise.resolve(onSubmitRef.current(step.submit)).then(answer, () => {
      answer(undefined);
    });
  }
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isFormField(event.target)) return;
      if (/^[0-9]$/.test(event.key))
        dispatchRef.current({ type: "digit", digit: event.key });
      else if (event.key === "Backspace" || event.key === "Delete")
        dispatchRef.current({ type: "delete" });
      else if (event.key === "Enter" && form === "adminPin")
        dispatchRef.current({ type: "ok" });
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [form]);

  const shake = {
    "data-shaking": shaking || undefined,
    onAnimationEnd: () => {
      setShaking(false);
    },
  };

  let entry: ReactNode;
  if (form === "joinCode") {
    entry = (
      <div
        key={refusals}
        role="group"
        aria-label={t("numberPad.joinCode")}
        className="flex justify-center gap-3 data-shaking:animate-shake"
        {...shake}
      >
        {Array.from({ length: JOIN_CODE_LENGTH }, (_, index) => (
          <span
            key={index}
            data-testid="code-box"
            data-next={index === pad.digits.length || undefined}
            className="flex h-20 w-16 items-center justify-center rounded-card-sm bg-white text-5xl font-bold text-ink shadow-ledge-sm data-next:outline-4 data-next:outline-blue"
          >
            {pad.digits[index] ?? ""}
          </span>
        ))}
      </div>
    );
  } else {
    const slots = Math.min(
      maxLength(form),
      Math.max(PIN_MIN_LENGTH, pad.digits.length + 1),
    );
    entry = (
      <div
        key={refusals}
        role="img"
        aria-label={t("numberPad.pinEntered", { count: pad.digits.length })}
        className="flex min-h-20 items-center justify-center gap-3 rounded-full bg-white px-6 shadow-ledge-sm data-shaking:animate-shake"
        {...shake}
      >
        {Array.from({ length: slots }, (_, index) => (
          <span
            key={index}
            data-filled={index < pad.digits.length || undefined}
            className="size-5 rounded-full bg-passed data-filled:bg-ink"
          />
        ))}
      </div>
    );
  }

  const refusedText =
    form === "joinCode" && pad.refused ? t("numberPad.codeRefused") : undefined;
  const shownMessage = message ?? refusedText;

  return (
    <div className={`flex w-full max-w-sm flex-col gap-4 ${className}`}>
      {form === "adminPin" ? (
        <div className="flex flex-col items-center gap-2">
          <span data-testid="pin-lock">
            <Icon name="lock" className="size-10" />
          </span>
          <h2 className="text-3xl font-bold">{t("numberPad.adminPin")}</h2>
        </div>
      ) : null}
      {entry}
      <p
        role="status"
        className="min-h-6 text-center text-lg font-semibold text-warn-fg"
      >
        {shownMessage}
      </p>
      <div
        data-testid="pad-grid"
        data-locked={locked || undefined}
        className="grid grid-cols-3 gap-3 data-locked:opacity-45 data-locked:grayscale-60"
      >
        {GRID.map((key, index) => {
          if (key === null) return <span key={index} />;
          if (key === "delete")
            return (
              <button
                key={key}
                type="button"
                aria-label={t("numberPad.delete")}
                className={KEY_CLASSES}
                onClick={() => {
                  dispatch({ type: "delete" });
                }}
              >
                <Icon name="backspace" className="size-8" />
              </button>
            );
          return (
            <button
              key={key}
              type="button"
              className={KEY_CLASSES}
              onClick={() => {
                dispatch({ type: "digit", digit: key });
              }}
            >
              {key}
            </button>
          );
        })}
      </div>
      {form === "adminPin" ? (
        <Button
          fill="green"
          isDisabled={
            locked || pad.digits.length < PIN_MIN_LENGTH || pad.pending
          }
          onPress={() => {
            dispatch({ type: "ok" });
          }}
          className="w-full"
        >
          {t("numberPad.ok")}
        </Button>
      ) : null}
    </div>
  );
}
