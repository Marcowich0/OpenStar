// Chips and pills: full-radius labels. A chip is a small tag (genre, year,
// Duet, best score, a warning); a pill is the ink label of toasts, Rank
// titles and the volume readout.

import type { ReactNode } from "react";

export type ChipTone = "plain" | "duet" | "best" | "warn" | "off";

const TONE_CLASSES: Record<ChipTone, string> = {
  plain: "bg-surface text-ink shadow-ledge-sm",
  duet: "bg-purple text-white shadow-ledge-sm",
  best: "bg-yellow text-on-bright shadow-ledge-yellow",
  warn: "bg-warn-bg text-warn-fg",
  off: "bg-passed text-ink-2",
};

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
}

export function Chip({ children, tone = "plain", className = "" }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-5 py-1.5 font-sans text-2xl font-semibold whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export interface PillProps {
  children: ReactNode;
  /** Pop in with overshoot when it appears (toasts). */
  popIn?: boolean;
  className?: string;
}

export function Pill({ children, popIn = false, className = "" }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-3 rounded-full bg-ink-fill px-7 py-2.5 font-sans text-3xl font-medium whitespace-nowrap text-white shadow-ledge-ink ${popIn ? "animate-pop-in" : ""} ${className}`}
    >
      {children}
    </span>
  );
}
