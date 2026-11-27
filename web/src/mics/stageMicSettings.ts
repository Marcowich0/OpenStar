/**
 * The Mic settings stored for the Stage's current Stage output (v1 spec #52,
 * ticket #169), held where both the Start of a Song and every meter can read
 * them without waiting.
 *
 * `StageMicSettingsLoader` (`StageMicSettings.tsx`) fills the Stage's holder,
 * `stageMicSettings()`, from `GET /api/mic-settings` when the Stage opens,
 * again whenever the output key changes (with nothing in between, so a Start
 * then sings on the defaults) and after every `micSettings` change notice (a
 * Calibration run or a hand setting). `singSetup` reads it once at Start; a
 * meter reads it, with the current OpenStar volume, for its threshold line.
 * Both go through `seatMicSettings`, so the line a meter draws is the
 * threshold Start would hand the scorer at that volume.
 */

import type { MicKey } from "../generated/MicKey";
import type { StageOutputMicSettings } from "../generated/StageOutputMicSettings";
import {
  resolveMicSettings,
  type MicKind,
  type MicSettings,
  type StoredMicSettings,
} from "./micSettings";

export interface StageMicSettings {
  /** The values of the current Stage output, or `null` while none are loaded. */
  set(values: StageOutputMicSettings | null): void;
  /** What is stored for `mic` at the current Stage output, if anything. */
  storedFor(mic: MicKey): StoredMicSettings | undefined;
  /**
   * Keeps a Mic threshold set by hand for a Local mic (dBFS at the reference
   * volume) in the loaded values at once, before the server's copy comes
   * back, and returns the Stage output it belongs to (`null`: none loaded,
   * so nothing to set it for).
   */
  setByHand(localMicId: string, referenceDbfs: number): string | null;
  /**
   * Replaces the input delays the Local mics report now, by Local mic id:
   * a Stage-browser device's (its track's `latency`) and a Mic bridge
   * channel's (`BridgeChannel.reportedInputDelayMs`, #153). Kept apart from
   * the stored values; listeners are not told.
   */
  setReportedInputDelays(delays: ReadonlyMap<string, number>): void;
  /** A Local mic's reported input delay now, ms (`null`: none reported). */
  reportedInputDelayMs(localMicId: string): number | null;
  /** Called after every `set`. */
  subscribe: (listener: () => void) => () => void;
  /** The loaded values (for `useSyncExternalStore`). */
  values: () => StageOutputMicSettings | null;
}

function sameMic(a: MicKey, b: MicKey): boolean {
  return a.kind === "phone"
    ? b.kind === "phone" && a.phoneId === b.phoneId
    : b.kind === "localMic" && a.localMicId === b.localMicId;
}

export function createStageMicSettings(): StageMicSettings {
  let loaded: StageOutputMicSettings | null = null;
  let reported: ReadonlyMap<string, number> = new Map();
  const listeners = new Set<() => void>();
  const set = (values: StageOutputMicSettings | null) => {
    loaded = values;
    for (const listener of [...listeners]) listener();
  };
  const storedFor = (mic: MicKey) =>
    loaded?.mics.find((entry) => sameMic(entry.mic, mic))?.settings;
  return {
    set,
    storedFor,
    setByHand(localMicId, referenceDbfs) {
      if (!loaded) return null;
      const { stageOutput, mics } = loaded;
      const mic: MicKey = { kind: "localMic", localMicId };
      const settings: StoredMicSettings = {
        ...storedFor(mic),
        micThreshold: { referenceDbfs, setBy: "hand" },
      };
      set({
        stageOutput,
        mics: [
          ...mics.filter((entry) => !sameMic(entry.mic, mic)),
          { mic, settings },
        ],
      });
      return stageOutput;
    },
    setReportedInputDelays(delays) {
      reported = delays;
    },
    reportedInputDelayMs: (localMicId) => reported.get(localMicId) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    values: () => loaded,
  };
}

let stage: StageMicSettings | null = null;

/** The Stage's holder, made on first use. */
export function stageMicSettings(): StageMicSettings {
  return (stage ??= createStageMicSettings());
}

/** What a seat sings into; a seat without a Mic counts as a Phone. */
export function micKindOf(mic: MicKey | null): MicKind {
  return mic?.kind === "localMic" ? "localMic" : "phone";
}

/**
 * The Mic delay and effective Mic threshold of a seat's Mic at the OpenStar
 * volume `volume`, from what is stored for it at the current Stage output
 * (`undefined`: the defaults). An uncalibrated Local mic's Mic delay is its
 * reported input delay (`reportedInputDelayMs`), or 0 ms when none is.
 */
export function seatMicSettings(
  mic: MicKey | null,
  stored: StoredMicSettings | undefined,
  volume: number,
  reportedInputDelayMs: number | null = null,
): MicSettings {
  return resolveMicSettings({
    kind: micKindOf(mic),
    stored,
    volume,
    reportedInputDelayMs,
  });
}
