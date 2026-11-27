/**
 * The Stage options (Setup › Options): the choices kept for the Stage that
 * change how a Party plays and looks. The server keeps one set at
 * `GET`/`PUT /api/stage-options`, with no Admin PIN, and sends the
 * `stageOptions` change notice when they change.
 *
 * The Stage's holder, `stageOptions()`, has them where code outside React
 * reads them without waiting: a Song's Start (effects, Line ratings, skipping
 * its Intro), each resume (the countdown) and each preview (its volume).
 * Until they load it holds the defaults, which are the behaviour before the
 * options existed. `StageOptionsLoader` fills it.
 *
 * To add an option: its field in `crates/protocol/src/stage_options.rs`, its
 * default and range in `STAGE_OPTIONS` below, and its row in
 * `OptionsList.tsx`.
 */

import { queryOptions } from "@tanstack/react-query";

import { api } from "../api/api";
import type { StageOptions } from "../generated/StageOptions";

export type { StageOptions };

/**
 * Every option's default and range (`crates/protocol/src/stage_options.rs`;
 * `web/checks/stageOptions.test.ts` keeps them equal).
 */
export const STAGE_OPTIONS = {
  defaults: {
    startingDifficulty: "medium",
    resumeCountdownSeconds: 3,
    lineRatings: true,
    effects: "full",
    songVideo: true,
    previewVolumePercent: 100,
    skipIntros: false,
  } satisfies StageOptions,
  resumeCountdownMaxSeconds: 5,
  previewVolumeStepPercent: 10,
} as const;

/** The defaults, as a fresh `StageOptions`. */
export function defaultStageOptions(): StageOptions {
  return { ...STAGE_OPTIONS.defaults };
}

export const stageOptionsKey = ["stageOptions"] as const;

/** `GET /api/stage-options`. */
export const stageOptionsQuery = queryOptions({
  queryKey: stageOptionsKey,
  queryFn: ({ signal }) => api("GET /api/stage-options", { signal }),
});

/** `PUT /api/stage-options`: stores `options` and returns what is kept. */
export function saveStageOptions(options: StageOptions): Promise<StageOptions> {
  return api("PUT /api/stage-options", { body: options });
}

export interface StageOptionsHolder {
  /** The loaded options, or the defaults while none are loaded. */
  current(): StageOptions;
  set(options: StageOptions | null): void;
}

export function createStageOptionsHolder(): StageOptionsHolder {
  let loaded: StageOptions | null = null;
  return {
    current: () => loaded ?? STAGE_OPTIONS.defaults,
    set(options) {
      loaded = options;
    },
  };
}

let stage: StageOptionsHolder | null = null;

/** The Stage's holder, made on first use. */
export function stageOptions(): StageOptionsHolder {
  return (stage ??= createStageOptionsHolder());
}

/**
 * The preview's gain at `percent` of the Song's level: `(p/100)²`, the
 * OpenStar volume's curve, so equal steps sound like equal steps.
 */
export function previewGain(percent: number): number {
  const p = Math.min(Math.max(percent, 0), 100) / 100;
  return p * p;
}
