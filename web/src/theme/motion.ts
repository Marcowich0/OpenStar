// The motion mode (spec #242, #260). The motion tokens live beside the colour
// tokens in `tokens.css`: spring durations and easings, the focus bounce, the
// press squash, the overlay spring and the toast drop. With the mode at
// "fade", the block `:root[data-motion="fade"]` there turns every one of
// them into a 120 ms fade with no scale or translate. `MotionMode` puts the
// mode on the document element, so portalled dialogs and sheets follow it
// too.

import { useLayoutEffect, useSyncExternalStore } from "react";

import type { StageOptions } from "../stageOptions/stageOptions";

export type Motion = "spring" | "fade";

/** The system's reduced-motion setting. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether the Stage options turn Effects off: the one reader for that
 * setting's effect on motion. #268 makes `effects` `"off" | "calm" | "full"`;
 * then this is `options.effects === "off"` (calm keeps the motion).
 */
export function effectsOff(options: StageOptions): boolean {
  return !options.effects;
}

function media(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener("change", onChange);
  return () => {
    list?.removeEventListener("change", onChange);
  };
}

function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

/**
 * Keeps `data-motion` on the document element while mounted: "fade" when
 * the system asks for reduced motion or `effectsOff`, else "spring". The
 * Stage and the Phone each mount one. Renders nothing.
 */
export function MotionMode({ effectsOff }: { effectsOff: boolean }) {
  const reduced = useSyncExternalStore(subscribe, prefersReducedMotion);
  const motion: Motion = reduced || effectsOff ? "fade" : "spring";
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = motion;
    return () => {
      delete root.dataset.motion;
    };
  }, [motion]);
  return null;
}
