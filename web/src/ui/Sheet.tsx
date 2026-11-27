// The Phone's shared sheet (v1 spec #49, "The Remote frame"): it slides up
// from the bottom over the current tab and closes when tapped outside it (or
// on Esc). React Aria's modal gives the focus trap, scroll lock and focus
// return, like `Dialog`; the slide is a CSS transition with the spring
// easing, driven by `data-entering` and `data-exiting`.

import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";

/**
 * How long the sheet takes to slide in (`duration-450` below). A close
 * asked for meanwhile waits for it: reversing the slide mid-way cancels the
 * transition React Aria waits for, which would leave the sheet's invisible
 * veil over the whole screen.
 */
export const SHEET_ENTER_MS = 450;

export interface SheetProps {
  /** The sheet's accessible name. Pass it through `t()`. */
  label: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  children: ReactNode;
  /** Covers the whole screen (the Profile page), not just its content. */
  fullScreen?: boolean;
}

export function Sheet({
  label,
  isOpen,
  onOpenChange,
  children,
  fullScreen = false,
}: SheetProps) {
  // True from each opening until the slide in has finished.
  const [entering, setEntering] = useState(isOpen);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setEntering(true);
  }
  useEffect(() => {
    if (!entering) return;
    const timer = setTimeout(() => {
      setEntering(false);
    }, SHEET_ENTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [entering]);

  return (
    <ModalOverlay
      data-testid="sheet-veil"
      isOpen={isOpen || entering}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-40 flex items-end bg-veil transition-opacity duration-250 data-entering:opacity-0 data-exiting:opacity-0"
    >
      <Modal
        className={`flex w-full flex-col ${fullScreen ? "h-dvh" : "max-h-[88dvh]"} rounded-t-card bg-cream text-ink shadow-[0_-6px_0_var(--color-ledge)] transition-transform duration-450 ease-spring data-entering:translate-y-full data-exiting:translate-y-full`}
      >
        <AriaDialog
          aria-label={label}
          className="flex min-h-0 flex-col font-sans outline-none"
        >
          <span
            aria-hidden="true"
            className="mx-auto mt-2.5 mb-1 h-1.5 w-11 rounded-full bg-ledge"
          />
          <div className="overflow-y-auto px-4.5 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
            {children}
          </div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
