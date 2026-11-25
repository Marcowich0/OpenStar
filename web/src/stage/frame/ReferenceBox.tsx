// A 1920 × 1080 box in the reference frame, centred and scaled uniformly to
// fit the screen. Every Stage size inside it is a reference-frame pixel.

import { useSyncExternalStore, type ReactNode } from "react";

import {
  REFERENCE_HEIGHT,
  REFERENCE_WIDTH,
  referenceScale,
} from "./referenceFrame";

function subscribe(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => {
    window.removeEventListener("resize", listener);
  };
}

/** The reference frame's current scale; re-renders when the window resizes. */
export function useReferenceScale(): number {
  return useSyncExternalStore(subscribe, () =>
    referenceScale(window.innerWidth, window.innerHeight),
  );
}

export interface ReferenceBoxProps {
  children: ReactNode;
  /**
   * The box lets the pointer through to what lies below; children that
   * take the pointer set `pointer-events-auto` themselves.
   */
  passThrough?: boolean;
}

export function ReferenceBox({
  children,
  passThrough = false,
}: ReferenceBoxProps) {
  const scale = useReferenceScale();
  return (
    <div
      data-reference-box
      className={`absolute top-1/2 left-1/2 origin-center ${passThrough ? "pointer-events-none" : ""}`}
      style={{
        width: REFERENCE_WIDTH,
        height: REFERENCE_HEIGHT,
        transform: `translate(-50%, -50%) scale(${String(scale)})`,
      }}
    >
      {children}
    </div>
  );
}
