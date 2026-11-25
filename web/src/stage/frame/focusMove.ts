// Arrow-key focus movement on the Stage (v1 spec #55, "One focus ring"): the
// focus goes to the nearest focusable element in the arrow's direction,
// scored as the distance along the arrow plus 2.2 × the sideways distance,
// both measured between the elements' centres.

export type FocusDirection = "left" | "right" | "up" | "down";

export interface FocusRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusCandidate<Id> {
  id: Id;
  rect: FocusRect;
}

/** How much more a step sideways costs than a step along the arrow. */
export const SIDEWAYS_WEIGHT = 2.2;

/** Centres closer than this on the arrow's axis are level, not "in front". */
const LEVEL_PX = 4;

/** The candidate to focus next, or `null` when nothing lies that way. */
export function nextFocus<Id>(
  from: FocusRect,
  candidates: readonly FocusCandidate<Id>[],
  direction: FocusDirection,
): Id | null {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: Id | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.rect.x + candidate.rect.width / 2 - cx;
    const dy = candidate.rect.y + candidate.rect.height / 2 - cy;
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    const along = sign * (horizontal ? dx : dy);
    if (along < LEVEL_PX) continue;
    const sideways = Math.abs(horizontal ? dy : dx);
    const score = along + SIDEWAYS_WEIGHT * sideways;
    if (score < bestScore) {
      bestScore = score;
      best = candidate.id;
    }
  }
  return best;
}
