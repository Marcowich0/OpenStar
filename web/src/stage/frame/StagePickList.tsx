// A pick list on the Stage: a small white menu with an ink edge, opened from
// a control (the Setup pill, a Line-up field). It is a layer, so Esc closes
// it before any overlay, and arrows and the mouse stay inside it while open.

import type { ReactNode } from "react";

import { StageLayer } from "./stageFrameContext";

export interface StagePickListProps {
  /** Esc, and picking an entry, should call it. */
  onClose: () => void;
  /** Names the list; pass it through `t()`. */
  "aria-label": string;
  children: ReactNode;
  /** Position utilities in the reference frame. */
  className?: string;
}

export function StagePickList({
  onClose,
  "aria-label": label,
  children,
  className = "",
}: StagePickListProps) {
  return (
    <StageLayer
      onDismiss={onClose}
      role="menu"
      aria-label={label}
      className={`absolute z-menu flex min-w-96 animate-pop-in flex-col gap-3 rounded-card-sm bg-white p-3 text-ink ring-4 ring-ink ${className}`}
    >
      {children}
    </StageLayer>
  );
}

/** One entry of a pick list: a full-width pill. */
export function StagePickListEntry({
  children,
  onPick,
}: {
  children: ReactNode;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex min-h-19 w-full cursor-pointer items-center rounded-full bg-cream px-6 text-left text-3xl font-semibold"
    >
      {children}
    </button>
  );
}
