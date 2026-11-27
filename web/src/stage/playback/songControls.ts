/**
 * Pause, the 3-2-1 resume countdown and Restart on the Stage (#158).
 *
 * The Stage acts on the Song controls the server passes it (`controlSong`
 * with `pause`, `resume` or `restart`, from the Stage itself or any Remote)
 * through these controls; who may send them is the server's and the
 * Remote's business. The media and the Song clock stay with the playback
 * adapter (`playback/mediaPlayback.ts`): a pause freezes both on the
 * element's `pause` event, a stall (`waiting`) freezes the clock there
 * without any of this, and the clock starts again only once the element
 * really plays. So during the countdown Song time stays frozen, and readings
 * whose moment falls in a pause, a stall or the countdown are dropped by the
 * placement rules (`clock/placement.ts`).
 *
 * Restart is the only seek on the sing screen: back to `#START`, and the
 * Song's scoring starts over (every Player's Pitch buffer cleared, every
 * scorer reset). Restart also unpauses, as the server's does, with no
 * countdown.
 */

import type { SongControl } from "../../generated/SongControl";
import type { MediaPlayback } from "../../playback/mediaPlayback";

export const RESUME_COUNTDOWN = {
  /** One number a second, down to 1. */
  stepMs: 1000,
  /**
   * The first number shown by default (the Stage options' resume countdown,
   * `resumeCountdownSeconds`; 0 plays on at once).
   */
  from: 3,
} as const;

/** What the sing screen shows over the Song. */
export type SongControlsState =
  | { phase: "playing" }
  | { phase: "paused" }
  /** The resume countdown over the frozen frame, showing `count`. */
  | { phase: "countdown"; count: number };

/** The Song controls the Stage acts on here; Start, End and Skip are the sing scene's. */
export type PlaybackControl = Extract<
  SongControl,
  "pause" | "resume" | "restart"
>;

export interface SongControlsOptions {
  playback: Pick<MediaPlayback, "pause" | "resume" | "restart">;
  /** The Song's Pitch buffers, one per Player; a Restart clears them. */
  buffers: () => readonly { clear(): void }[];
  /** The Song's scorers, one per Player; a Restart resets them. */
  scorers: () => readonly { reset(): void }[];
  /** Raised on every change of `state`. */
  onChange?: (state: SongControlsState) => void;
  /** Raised when the browser refuses to play (after the countdown or a Restart). */
  onPlayFailed?: (error: unknown) => void;
  /** Runs `run` after `ms`; returns a cancel. `setTimeout` by default. */
  schedule?: (run: () => void, ms: number) => () => void;
  /**
   * The countdown's first number, read at each resume (`RESUME_COUNTDOWN.from`
   * by default); 0 plays on at once.
   */
  countdownFrom?: () => number;
}

export interface SongControls {
  readonly state: SongControlsState;
  /** Pauses the Song (also stops a running countdown). Pause when paused: no change. */
  pause(): void;
  /** From a pause: the countdown, then the Song plays on. Otherwise no change. */
  resume(): void;
  /** Back to `#START` with the scoring cleared, playing (also from a pause). */
  restart(): void;
  /** Acts on a `controlSong` the server sent. */
  apply(control: PlaybackControl): void;
  /** Stops a running countdown; nothing plays afterwards (the Song left the screen). */
  dispose(): void;
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms);
  return () => {
    clearTimeout(handle);
  };
}

/** The controls of a Song that has just started playing. */
export function createSongControls(options: SongControlsOptions): SongControls {
  const { playback } = options;
  const schedule = options.schedule ?? defaultSchedule;
  const playFailed = (error: unknown) => {
    options.onPlayFailed?.(error);
  };

  let state: SongControlsState = { phase: "playing" };
  let cancels: (() => void)[] = [];

  function set(next: SongControlsState) {
    state = next;
    options.onChange?.(next);
  }

  function stopCountdown() {
    for (const cancel of cancels) cancel();
    cancels = [];
  }

  const controls: SongControls = {
    get state() {
      return state;
    },
    pause() {
      if (state.phase === "paused") return;
      stopCountdown();
      playback.pause();
      set({ phase: "paused" });
    },
    resume() {
      if (state.phase !== "paused") return;
      const from = Math.max(
        0,
        Math.round(options.countdownFrom?.() ?? RESUME_COUNTDOWN.from),
      );
      if (from === 0) {
        set({ phase: "playing" });
        playback.resume().catch(playFailed);
        return;
      }
      const step = RESUME_COUNTDOWN.stepMs;
      set({ phase: "countdown", count: from });
      // Every step is timed from the resume itself, so the countdown lasts
      // exactly `from` seconds however late a timer runs.
      for (let shown = 1; shown < from; shown += 1) {
        cancels.push(
          schedule(() => {
            set({ phase: "countdown", count: from - shown });
          }, shown * step),
        );
      }
      cancels.push(
        schedule(() => {
          cancels = [];
          set({ phase: "playing" });
          playback.resume().catch(playFailed);
        }, from * step),
      );
    },
    restart() {
      stopCountdown();
      // The seek first: it marks the Restart on the clock, so a reading
      // placed from here on is either after it or dropped.
      playback.restart().catch(playFailed);
      for (const buffer of options.buffers()) buffer.clear();
      for (const scorer of options.scorers()) scorer.reset();
      if (state.phase !== "playing") set({ phase: "playing" });
    },
    apply(control) {
      controls[control]();
    },
    dispose: stopCountdown,
  };
  return controls;
}
