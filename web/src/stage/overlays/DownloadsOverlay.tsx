// The Downloads overlay (Setup menu → Downloads): the Admin area's Downloads
// section (`admin/Downloads.tsx`) on the Stage. Marc asked for Downloads on
// the Stage (2026-11-27): the Stage computer is sometimes a desktop with a
// keyboard and mouse, sometimes a TV. It is an overlay, so `/stage` is still
// never navigated away from and the live Party keeps running. Starting a
// Download stays guarded: the section's own guarded-action flow opens the
// Admin PIN pad, and the server decides.
//
// The section is drawn larger (`zoom`), so its admin-sized text reads at
// Stage scale. The one focus ring moves over its buttons and its USDB search
// box with the arrows and the mouse; in the box the keys are the box's
// (`isTextField`), and ↓ or ↑ leaves it. The video picker and the Admin PIN
// pad are dialogs above the frame and take their own keys.

import "./downloadsOverlay.css";

import { useRef } from "react";

import { Downloads } from "../../admin/Downloads";
import { focusablesIn, isTextField } from "../frame/focusables";
import { useStageFrame, useStageKeys } from "../frame/stageFrameContext";

/** The Admin area's 768 px column, at the overlay's width. */
const STAGE_ZOOM = 1.6;

/**
 * Moves the focus out of the search box in `root` to the layer's next (or
 * previous) focusable; `false` when the focus is not in a text field there.
 */
function leaveField(root: HTMLElement | null, step: 1 | -1): boolean {
  const active = document.activeElement;
  if (!root || !isTextField(active) || !root.contains(active)) return false;
  const layer = root.closest("[data-stage-layer]") ?? root;
  const all = focusablesIn(layer);
  const at = all.findIndex((element) => element === active);
  all[at + step]?.focus({ preventScroll: true });
  return true;
}

export function DownloadsOverlay() {
  const { store } = useStageFrame();
  const rootRef = useRef<HTMLDivElement>(null);
  useStageKeys({
    ArrowDown: () => leaveField(rootRef.current, 1),
    ArrowUp: () => leaveField(rootRef.current, -1),
  });

  return (
    <div
      ref={rootRef}
      data-downloads-overlay=""
      style={{ zoom: STAGE_ZOOM }}
      onFocus={(event) => {
        // The frame moves the focus without scrolling; the overlay scrolls.
        // (jsdom has no scrollIntoView.)
        const target: Partial<Pick<HTMLElement, "scrollIntoView">> =
          event.target;
        target.scrollIntoView?.({ block: "nearest" });
      }}
    >
      <Downloads store={store} showTitle={false} />
    </div>
  );
}
