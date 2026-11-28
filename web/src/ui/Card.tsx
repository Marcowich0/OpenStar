import type { ReactNode } from "react";

const RADIUS_CLASSES = {
  small: "rounded-card-sm",
  medium: "rounded-card",
  large: "rounded-card-lg",
} as const;

export interface CardProps {
  children: ReactNode;
  /** 36, 44 or 52 px in the reference frame. */
  radius?: keyof typeof RADIUS_CLASSES;
  /** Pop in with overshoot when it appears. */
  popIn?: boolean;
  /** Layout and padding utilities from the caller. */
  className?: string;
}

/** A white Bubble Pop card on a solid ledge. */
export function Card({
  children,
  radius = "medium",
  popIn = false,
  className = "p-7",
}: CardProps) {
  return (
    <div
      className={`bg-surface text-ink shadow-ledge-lg ${RADIUS_CLASSES[radius]} ${popIn ? "animate-pop-in" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
