// The Stage's 1920 × 1080 reference frame (v1 spec #55): every Stage size is
// given in it, and it scales uniformly to fit the screen. Backgrounds and the
// video fill the whole screen outside it.

export const REFERENCE_WIDTH = 1920;
export const REFERENCE_HEIGHT = 1080;

/** The uniform scale that fits the reference frame on a `width × height` screen. */
export function referenceScale(width: number, height: number): number {
  return Math.min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT);
}
