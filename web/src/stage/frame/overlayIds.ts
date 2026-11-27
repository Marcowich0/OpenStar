/**
 * The Stage's overlays: Songs, Queue and People (`S`, `Q`, `P` and the pill
 * row), the screens the Setup menu opens, and the Song detail (the
 * best-score chip, `openSongDetail`). Add one here and in `OVERLAYS`
 * (`overlays.tsx`).
 */
export type OverlayId =
  | "songs"
  | "queue"
  | "people"
  | "mics"
  | "calibrateMics"
  | "avSync"
  | "downloads"
  | "songDetail";

/** The overlay each letter key toggles. */
export const OVERLAY_KEYS: Readonly<Record<string, OverlayId>> = {
  s: "songs",
  q: "queue",
  p: "people",
};
