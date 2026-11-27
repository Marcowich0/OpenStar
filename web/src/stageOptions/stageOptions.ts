/**
 * The Stage options (Setup › Options): the choices kept for the Stage that
 * change how a Party plays and looks. The server keeps one set at
 * `GET`/`PUT /api/stage-options`, with no Admin PIN, and sends the
 * `stageOptions` change notice when they change.
 *
 * The Stage's holder, `stageOptions()`, has them where code outside React
 * reads them without waiting: a Song's Start (effects, Line ratings, skipping
 * its Intro), each resume (the countdown), each preview (its volume) and each
 * UI sound (its level).
 * Until they load it holds the defaults, which are the behaviour before the
 * options existed. `StageOptionsLoader` fills it.
 *
 * To add an option: its field in `crates/protocol/src/stage_options.rs`, its
 * default and range in `STAGE_OPTIONS` below, its name in `optionNames.ts`,
 * and its row in `OptionsList.tsx`.
 */

import { queryOptions } from "@tanstack/react-query";

import { api } from "../api/api";
import type { StageOptions } from "../generated/StageOptions";
import { DEFAULT_THEME } from "../theme/themes";
import { DEFAULT_EFFECTS, EFFECTS } from "./effects";

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
    effects: DEFAULT_EFFECTS,
    songVideo: true,
    previewVolumePercent: 100,
    skipIntros: false,
    lyricSize: "m",
    showNextLine: true,
    laneFrostingPercent: 66,
    theme: DEFAULT_THEME,
    uiSoundsPercent: 60,
  } satisfies StageOptions,
  /** 0 (plays on at once) to 5 seconds. */
  resumeCountdown: { min: 0, max: 5, step: 1 },
  /** 0 to 100 % of the Song's level in 10s. */
  previewVolume: { min: 0, max: 100, step: 10 },
  /** 40 to 90 % in 10s; the default, 66, is off the steps. */
  laneFrosting: { min: 40, max: 90, step: 10 },
  /** The UI and game sounds, 0 (off) to 100 % in 10s. */
  uiSounds: { min: 0, max: 100, step: 10 },
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

/**
 * Whether the Stage options turn Effects off (`EFFECTS.off`: only Off, not
 * Calm), for the motion mode (its fades), the sing screen's background
 * blobs, the results bars (through the motion mode) and the effect sounds.
 * What Calm and Full show on the sing screen is `EFFECTS`' other tests.
 */
export function effectsOff(options: Pick<StageOptions, "effects">): boolean {
  return EFFECTS.off(options.effects);
}
