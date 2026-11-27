/**
 * Line ratings on the sing screen (#55, "Line ratings"): when a Line ends,
 * its rating word pops about 110 px right of the lane header, and a Perfect!
 * Line throws a confetti burst from the header.
 *
 * A pop moves on real frame time, like the particles (`effects.ts`): the
 * render loop advances `SingState.ratings` by each frame's delta, and
 * `frame()` turns each showing pop into a `lineRating` entry. The word itself
 * is DOM (`lineRatingWriter.ts`), so it is set in Fredoka with a CSS outline;
 * the painter skips the entry.
 *
 * Storage is one fixed slot per lane, allocated once, so a pop allocates
 * nothing; a lane's newer rating replaces the one it still shows.
 */

import { SCORING } from "../../scoring/constants";
import type { LineRatingKey, LineResult } from "../../scoring/scorer";
import { EFFECTS } from "../../stageOptions/effects";
import type { PaletteKey } from "../../theme/tokens";
import { confettiBurst, MAX_FRAME_DELTA } from "./effects";
import type { DrawList, SingLane, SingState } from "./frame";
import { MAX_LANES, type LaneLayout } from "./laneLayout";
import { singLayout } from "./singLook";

/** One showing Line rating, as the DOM writer places it. */
export interface LineRatingEntry {
  type: "lineRating";
  lane: number;
  /** The word's `t()` key. */
  word: LineRatingKey;
  /** The word's centre, reference frame, before `rise`. */
  x: number;
  y: number;
  /** Font size, px. */
  size: number;
  colour: PaletteKey;
  /** 0.3 → 1.2 → 1. */
  scale: number;
  /** 0–1. */
  alpha: number;
  /** How far it has risen, px (upwards). */
  rise: number;
}

/** How long a pop lasts, seconds. */
export const LINE_RATING_SECONDS = 1.3;
/** The word sits this far right of the lane header (its centre), px. */
export const LINE_RATING_OFFSET = 110;
/** Grows to `GROW_TO` over this share of the pop… */
const GROW_SHARE = 0.2;
/** …then settles at 100 % by this share… */
const SETTLE_SHARE = 0.35;
/** …and fades out from this share on, rising `RISE` px. */
const FADE_SHARE = 0.7;
const GROW_FROM = 0.3;
const GROW_TO = 1.2;
const RISE = 20;

function easeOut(x: number): number {
  return 1 - (1 - x) * (1 - x);
}

/**
 * The pop's look `age` seconds after the Line ended; `null` outside it.
 * Without `motion` (Effects calm or off) it neither grows nor rises: it
 * shows at full size and only fades out.
 */
export function lineRatingPop(
  age: number,
  motion = true,
): { scale: number; alpha: number; rise: number } | null {
  if (age < 0 || age > LINE_RATING_SECONDS) return null;
  const p = age / LINE_RATING_SECONDS;
  const fade = p > FADE_SHARE ? (p - FADE_SHARE) / (1 - FADE_SHARE) : 0;
  if (!motion) return { scale: 1, alpha: 1 - fade, rise: 0 };
  let scale = 1;
  if (p < GROW_SHARE) {
    scale = GROW_FROM + (GROW_TO - GROW_FROM) * easeOut(p / GROW_SHARE);
  } else if (p < SETTLE_SHARE) {
    const x = (p - GROW_SHARE) / (SETTLE_SHARE - GROW_SHARE);
    scale = GROW_TO - (GROW_TO - 1) * easeOut(x);
  }
  return { scale, alpha: 1 - fade, rise: RISE * fade };
}

/** Each lane's showing Line rating, aged on real time. */
export class LineRatings {
  private readonly words: (LineRatingKey | null)[] =
    new Array<LineRatingKey | null>(MAX_LANES).fill(null);
  private readonly ages = new Float64Array(MAX_LANES);

  /** Starts lane `lane`'s pop of `word`, replacing the one it shows. */
  show(lane: number, word: LineRatingKey): void {
    if (lane < 0 || lane >= MAX_LANES) return;
    this.words[lane] = word;
    this.ages[lane] = 0;
  }

  /** Ages every pop by a real delta, clamped to `MAX_FRAME_DELTA`. */
  advance(delta: number): void {
    if (!(delta > 0)) return;
    const dt = Math.min(delta, MAX_FRAME_DELTA);
    for (let lane = 0; lane < MAX_LANES; lane++) {
      if (this.words[lane] === null) continue;
      const age = (this.ages[lane] ?? 0) + dt;
      this.ages[lane] = age;
      if (age > LINE_RATING_SECONDS) this.words[lane] = null;
    }
  }

  /** Drops every pop (a Restart). */
  clear(): void {
    this.words.fill(null);
  }

  /**
   * Appends a `lineRating` entry per showing pop; without `motion` (Effects
   * calm or off) a pop only fades.
   */
  draw(
    list: DrawList,
    lanes: readonly SingLane[],
    layout: LaneLayout,
    motion = true,
  ): void {
    for (let lane = 0; lane < MAX_LANES; lane++) {
      const word = this.words[lane] ?? null;
      const rect = layout[lane];
      const player = lanes[lane];
      if (word === null || !rect || !player) continue;
      const pop = lineRatingPop(this.ages[lane] ?? 0, motion);
      if (!pop) continue;
      list.push({
        type: "lineRating",
        lane,
        word,
        x: rect.notesX + LINE_RATING_OFFSET,
        y: rect.y + rect.height / 2,
        size: rect.height < 90 ? 30 : 40,
        colour: player.colour,
        scale: pop.scale,
        alpha: pop.alpha,
        rise: pop.rise,
      });
    }
  }
}

/**
 * Lane `lane`'s Line ended with `result` (from the scorer's feed): pops its
 * word, if it has one, and bursts confetti from the lane header on Perfect!
 * when Effects is full.
 */
export function lineEnded(
  state: SingState,
  lane: number,
  result: Pick<LineResult, "rating" | "word">,
): void {
  if (result.word !== null) state.ratings?.show(lane, result.word);
  if (
    result.rating < SCORING.lineRatingScale ||
    !state.effects ||
    !EFFECTS.confetti(state.effectsMode ?? "full")
  )
    return;
  const player = state.lanes[lane];
  const rect = singLayout(state)[lane];
  if (!player || !rect) return;
  confettiBurst(
    state.effects,
    (rect.x + rect.notesX) / 2,
    rect.y + rect.height / 2,
    player.colour,
  );
}
