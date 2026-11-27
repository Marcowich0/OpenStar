// An overlay's spring out (#260). An overlay goes as soon as it closes, so
// the focus returns, its layer leaves the stack and its content unmounts at
// once. What the eye sees leave is its ghost: a lifeless copy in the same
// place, marked `data-leaving`, which the overlay's own classes animate out
// (`in-data-leaving:animate-overlay-out`, a token of `tokens.css`, a fade
// with reduced motion). The copy goes when its animations finish.

import { useLayoutEffect, type RefObject } from "react";

/** The longest a ghost stays, whatever its animations do. */
export const EXIT_GHOST_MAX_MS = 1000;

/** What a ghost must not keep: what finds, names or plays the real thing. */
const DROPPED_ATTRIBUTES = [
  "id",
  "role",
  "aria-modal",
  "aria-labelledby",
  "aria-describedby",
  "data-testid",
  "data-overlay",
  "data-stage-layer",
];
const DROPPED_ELEMENTS = "video, audio, iframe";

/**
 * Leaves a ghost of `ref`'s element where it was when it unmounts. Only in a
 * browser with Web Animations (`getAnimations`), which tells when the ghost's
 * animations end; elsewhere (and in tests' DOM) the element simply goes.
 */
export function useExitGhost(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.parentNode;
    if (!element || !parent) return;
    return () => {
      const next = element.nextSibling;
      // After the commit: an element still on the page was not closed (a
      // StrictMode re-run, or a move).
      queueMicrotask(() => {
        if (element.isConnected || !parent.isConnected) return;
        leaveGhost(element, parent, next?.parentNode === parent ? next : null);
      });
    };
  }, [ref]);
}

function leaveGhost(element: HTMLElement, parent: Node, before: Node | null) {
  if (typeof element.getAnimations !== "function") return;
  const ghost = element.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...ghost.querySelectorAll("*")]) {
    for (const name of DROPPED_ATTRIBUTES) node.removeAttribute(name);
  }
  for (const node of ghost.querySelectorAll(DROPPED_ELEMENTS)) node.remove();
  ghost.setAttribute("data-leaving", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.style.pointerEvents = "none";
  parent.insertBefore(ghost, before);

  const remove = () => {
    clearTimeout(timer);
    ghost.remove();
  };
  const timer = setTimeout(remove, EXIT_GHOST_MAX_MS);
  // Endless animations (a breathing button) are not waited for.
  const ending = ghost
    .getAnimations({ subtree: true })
    .filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime),
    )
    .map((animation) => animation.finished);
  void Promise.allSettled(ending).then(remove);
}
