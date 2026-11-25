// The Bubble Pop button: a full-radius pill with a solid ledge in its own
// darker colour. React Aria does the behaviour; a disabled button stays
// focusable and pressable on purpose, so that a press can shake it (±12 px,
// about 0.3 s) instead of doing nothing (v1 spec #55: "a press on a disabled
// control shakes it").

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

export type ButtonFill = "white" | "green" | "red" | "ink";

const FILL_CLASSES: Record<ButtonFill, string> = {
  white: "bg-white text-ink shadow-ledge",
  green: "bg-green text-white shadow-ledge-green",
  red: "bg-red text-white shadow-ledge-red",
  ink: "bg-ink text-white shadow-ledge-ink",
};

const SIZE_CLASSES = {
  /** About 76 px tall in the reference frame. */
  medium: "min-h-19 px-10 text-3xl font-semibold",
  /** About 104 px tall with 48 px text: Start, Sing!. */
  big: "min-h-26 px-20 text-5xl font-bold",
} as const;

export interface ButtonProps {
  children: ReactNode;
  fill?: ButtonFill;
  size?: keyof typeof SIZE_CLASSES;
  /** The breathing Sing / Start button. A disabled button never breathes. */
  breathing?: boolean;
  /** Greyed and shaking when pressed; `onPress` is not called. */
  isDisabled?: boolean;
  onPress?: () => void;
  /** Layout utilities from the caller (position, width). */
  className?: string;
}

export function Button({
  children,
  fill = "white",
  size = "medium",
  breathing = false,
  isDisabled = false,
  onPress,
  className = "",
}: ButtonProps) {
  const [shaking, setShaking] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // React Aria's Button does not forward animation events.
  useEffect(() => {
    const button = ref.current;
    if (!shaking || !button) return;
    const stop = () => {
      setShaking(false);
    };
    button.addEventListener("animationend", stop);
    return () => {
      button.removeEventListener("animationend", stop);
    };
  }, [shaking]);
  const classes = [
    "inline-flex items-center justify-center gap-3 rounded-full font-sans outline-none",
    "transition-transform duration-200 data-pressed:scale-95",
    "data-focus-visible:outline-6 data-focus-visible:outline-yellow",
    FILL_CLASSES[fill],
    SIZE_CLASSES[size],
    isDisabled
      ? "cursor-not-allowed opacity-45 grayscale-60"
      : "cursor-pointer",
    breathing && !isDisabled ? "animate-breathe" : "",
    "data-shaking:animate-shake",
    className,
  ];
  return (
    <AriaButton
      aria-disabled={isDisabled}
      data-shaking={shaking || undefined}
      ref={ref}
      onPress={() => {
        if (isDisabled) setShaking(true);
        else onPress?.();
      }}
      className={classes.filter(Boolean).join(" ")}
    >
      {children}
    </AriaButton>
  );
}
