// Display names for what a Line-up seat holds besides its member.

import type { Difficulty } from "../generated/Difficulty";
import type { SeatVoice } from "../generated/SeatVoice";
import { t, type MessageKey } from "./t";

/** Every Difficulty's display name, exhaustive over the generated union. */
export const DIFFICULTY_NAME_KEYS = {
  easy: "difficulty.easy",
  medium: "difficulty.medium",
  hard: "difficulty.hard",
} as const satisfies Record<Difficulty, MessageKey>;

/** A Difficulty's display name ("Hard"): on the Line-up and in toasts. */
export function difficultyName(difficulty: Difficulty): string {
  return t(DIFFICULTY_NAME_KEYS[difficulty]);
}

/** The number a Voice is shown with: 1 or 2. */
export function voiceNumber(voice: SeatVoice): number {
  return voice === "p1" ? 1 : 2;
}
