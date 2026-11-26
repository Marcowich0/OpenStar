// The press-and-hold button for destructive actions (Restart, Skip, End,
// removing a Request or a Party member; on the Stage also New party and taking
// the Stage back). Holding it for `HOLD_DURATION_MS` fills it from the left
// and then runs `onHold`; releasing early or leaving the button cancels; a
// short tap shows "Hold for a moment". No confirmation sheet, no Undo toast.
//
// Touch, mouse and the Enter key all drive it: Enter key down starts a hold
// and key up ends it, so the Stage works it from the keyboard. A plain click
// does nothing, so a pocket tap never fires it.
//
// A disabled hold button (`isDisabled`, for example a Library write while the
// Library is read-only) never fills or fires; a press shakes it instead, like
// a disabled `Button` (v1 spec #55).

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { t } from "../i18n/t";
import { HOLD_DURATION_MS, IDLE, holdStep, type HoldEvent } from "./hold";

/** How long the "Hold for a moment" hint stays after a short tap. */
const HINT_MS = 2000;

export type HoldButtonFill = "white" | "red" | "ink";

const FILL_CLASSES: Record<HoldButtonFill, { button: string; fill: string }> = {
  white: { button: "bg-white text-ink shadow-ledge", fill: "bg-ink/15" },
  red: { button: "bg-red text-white shadow-ledge-red", fill: "bg-white/35" },
  ink: { button: "bg-ink text-white shadow-ledge-ink", fill: "bg-white/35" },
};

const SIZE_CLASSES = {
  /** 64 px tall: a thumb's press. */
  medium: "min-h-16 px-8 text-2xl font-semibold",
  /** 48 px tall: the × on a list row, still one thumb. */
  small: "min-h-12 min-w-12 px-4 text-xl font-semibold",
} as const;

export interface HoldButtonProps {
  children: ReactNode;
  /** Runs once when a hold completes. */
  onHold: () => void;
  fill?: HoldButtonFill;
  size?: keyof typeof SIZE_CLASSES;
  /** Names the button when its content is only an icon (the ×). */
  "aria-label"?: string;
  /** Layout utilities for the wrapper (position, width). */
  className?: string;
  /** Greyed and shaking when pressed; `onHold` is never called. */
  isDisabled?: boolean;
}

export function HoldButton({
  children,
  onHold,
  fill = "white",
  size = "medium",
  "aria-label": ariaLabel,
  className = "",
  isDisabled = false,
}: HoldButtonProps) {
  const state = useRef(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const [shaking, setShaking] = useState(false);
  const onHoldRef = useRef(onHold);
  useEffect(() => {
    onHoldRef.current = onHold;
  }, [onHold]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(hintTimer.current);
    },
    [],
  );

  function dispatch(event: HoldEvent) {
    if (isDisabled) {
      if (event.type === "press") setShaking(true);
      return;
    }
    const step = holdStep(state.current, event);
    state.current = step.state;
    const isHolding = step.state.phase === "holding";
    setHolding(isHolding);
    if (event.type === "press" && isHolding) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        dispatch({ type: "tick", at: Date.now() });
      }, HOLD_DURATION_MS);
      setHint(false);
    }
    if (!isHolding) clearTimeout(timer.current);
    if (step.hint) {
      setHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => {
        setHint(false);
      }, HINT_MS);
    }
    if (step.fire) onHoldRef.current();
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    // Touch captures the pointer to the button; let it go, so sliding the
    // finger off the button cancels the hold as it does with a mouse.
    const button = event.currentTarget;
    if (typeof button.releasePointerCapture === "function") {
      try {
        button.releasePointerCapture(event.pointerId);
      } catch {
        // No capture to release.
      }
    }
    dispatch({ type: "press", at: Date.now() });
  }

  function isHoldKey(event: KeyboardEvent) {
    return event.key === "Enter" || event.key === " ";
  }

  const classes = [
    "relative inline-flex w-full items-center justify-center gap-3 overflow-hidden",
    "touch-none rounded-full font-sans outline-none select-none",
    "focus-visible:outline-6 focus-visible:outline-yellow",
    FILL_CLASSES[fill].button,
    SIZE_CLASSES[size],
    isDisabled
      ? "cursor-not-allowed opacity-45 grayscale-60"
      : "cursor-pointer",
    "data-shaking:animate-shake",
  ].join(" ");

  return (
    <span className={`relative inline-flex flex-col ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-disabled={isDisabled || undefined}
        data-holding={holding || undefined}
        data-shaking={shaking || undefined}
        onAnimationEnd={() => {
          setShaking(false);
        }}
        className={classes}
        onPointerDown={onPointerDown}
        onPointerUp={() => {
          dispatch({ type: "release", at: Date.now() });
        }}
        onPointerLeave={() => {
          dispatch({ type: "leave" });
        }}
        onPointerCancel={() => {
          dispatch({ type: "leave" });
        }}
        onBlur={() => {
          dispatch({ type: "leave" });
        }}
        onKeyDown={(event) => {
          if (!isHoldKey(event)) return;
          // The native button would click on Enter; the hold owns the key.
          event.preventDefault();
          if (!event.repeat) dispatch({ type: "press", at: Date.now() });
        }}
        onKeyUp={(event) => {
          if (!isHoldKey(event)) return;
          event.preventDefault();
          dispatch({ type: "release", at: Date.now() });
        }}
        onContextMenu={(event) => {
          // A long touch would open the context menu instead.
          event.preventDefault();
        }}
      >
        <span
          aria-hidden="true"
          data-testid="hold-fill"
          className={`pointer-events-none absolute inset-0 origin-left ${FILL_CLASSES[fill].fill}`}
          style={{
            transform: holding ? "scaleX(1)" : "scaleX(0)",
            transition: holding
              ? `transform ${String(HOLD_DURATION_MS)}ms linear`
              : "none",
          }}
        />
        <span className="relative inline-flex items-center gap-3">
          {children}
        </span>
      </button>
      <span
        role="status"
        className="absolute top-full right-0 left-0 mt-2 text-center text-base font-medium whitespace-nowrap opacity-75"
      >
        {hint ? t("hold.hint") : null}
      </span>
    </span>
  );
}
