// OpenStar's own dialog: React Aria's headless modal (focus trap, Esc,
// scroll lock, focus return, `role="dialog"` labelled by its heading) in
// Bubble Pop styling, the pattern later components follow. Every colour,
// radius, shadow and easing is a token utility; motion is a CSS transition
// by the motion tokens (#260: springing in, winding up and out), driven by
// React Aria's `data-entering` and `data-exiting` states, with no JavaScript
// animation.

import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";

export interface DialogProps {
  /** The dialog's heading, also its accessible name. Pass it through `t()`. */
  title: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Close when the veil around the dialog is pressed (Esc always closes). */
  isDismissable?: boolean;
  children: ReactNode;
}

export function Dialog({
  title,
  isOpen,
  onOpenChange,
  isDismissable = true,
  children,
}: DialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 flex items-center justify-center bg-veil p-6 transition-opacity duration-(--motion-spring) ease-spring data-entering:opacity-0 data-exiting:opacity-0 data-exiting:duration-(--motion-exit)"
    >
      <Modal className="w-full max-w-lg rounded-card bg-cream text-ink shadow-ledge-lg transition-transform duration-(--motion-spring) ease-spring data-entering:scale-(--motion-overlay-scale) data-exiting:scale-(--motion-overlay-scale) data-exiting:duration-(--motion-exit) data-exiting:ease-exit">
        <AriaDialog className="flex flex-col gap-6 p-8 font-sans outline-none">
          <Heading slot="title" className="text-3xl font-bold">
            {title}
          </Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
