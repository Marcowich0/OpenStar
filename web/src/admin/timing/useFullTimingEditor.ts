// Whether this browser gets the full Timing editor (v1 spec #57): only one
// with a fine pointer and room for it. Any other browser, a Phone above all,
// gets Fit to the singing alone (`PhoneAutoFit.tsx`).

import { useSyncExternalStore } from "react";

/** A fine pointer (mouse or trackpad) and at least the `md` width. */
export const FULL_EDITOR_QUERY = "(pointer: fine) and (min-width: 48rem)";

function media(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(FULL_EDITOR_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener("change", onChange);
  return () => {
    list?.removeEventListener("change", onChange);
  };
}

/** Follows the browser: turning a tablet or resizing a window switches views. */
export function useFullTimingEditor(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false);
}
