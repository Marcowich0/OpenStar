/**
 * The Stage option Effects (`"off" | "calm" | "full"`, default `full`): one
 * place that says what each value shows, so the sing screen and the Stage's
 * motion read it the same way. It imports only a type, so the pure draw list
 * (`stage/sing/frame.ts`) can use it.
 */

import type { Effects } from "../generated/Effects";

export type { Effects };

/** Full: today's behaviour (`EFFECTS_DEFAULT` on the server). */
export const DEFAULT_EFFECTS: Effects = "full";

/**
 * What each Effects value shows. **Full**: confetti on a Perfect! Line,
 * sparkles on a golden Note, and the sing screen's motion (the head ball's
 * bounce, a Line rating's pop). **Calm**: the sparkles only. **Off**:
 * neither, and the Stage's motion turns into fades.
 */
export const EFFECTS = {
  confetti: (effects: Effects): boolean => effects === "full",
  sparkles: (effects: Effects): boolean => effects !== "off",
  screenMotion: (effects: Effects): boolean => effects === "full",
  /**
   * The one test for "Effects off": the Stage's motion (focus, presses,
   * overlays, toasts; #260) turns into fades. Calm keeps that motion.
   */
  off: (effects: Effects): boolean => effects === "off",
} as const;
