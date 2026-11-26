// Keeps the Stage's Mic settings holder (`stageMicSettings.ts`) filled with
// the values stored for the current Stage output: loaded when the Stage
// opens, again when the output key changes, and after every `micSettings`
// change notice (a Calibration run or a hand setting stored), since the
// query's key starts with that topic's prefix. `StageScreen` mounts it inside
// `StageOutputProvider`. It renders nothing.

import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { api } from "../api/api";
import type { MicKey } from "../generated/MicKey";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { OPENSTAR_VOLUME } from "../playback/gain";
import { useStageOutput } from "../stage/output/StageOutput";
import { atReferenceVolume, type ThresholdSource } from "./micSettings";
import {
  seatMicSettings,
  stageMicSettings,
  type StageMicSettings,
} from "./stageMicSettings";

/** `GET /api/mic-settings`: every Mic's values at one Stage output. */
export function stageOutputMicSettingsQuery(stageOutput: string) {
  return queryOptions({
    queryKey: ["micSettings", "stageOutput", stageOutput],
    queryFn: ({ signal }) =>
      api("GET /api/mic-settings", { query: { stageOutput }, signal }),
  });
}

export function StageMicSettingsLoader({
  outputKey: givenKey,
  settings = stageMicSettings(),
  onUncalibratedOutput,
}: {
  /** Tests only: the output key (by default the Stage output's). */
  outputKey?: string | null;
  /** Tests only: the holder to fill. */
  settings?: StageMicSettings;
  /**
   * The output key changed to one at which no Mic has values stored: the
   * Stage shows "Sound output changed: calibrate mics". Never for the
   * first output read, nor for a refetch at the same output.
   */
  onUncalibratedOutput?: () => void;
}) {
  const stageOutput = useStageOutput();
  const outputKey = givenKey === undefined ? stageOutput.outputKey : givenKey;
  const { data } = useQuery({
    ...stageOutputMicSettingsQuery(outputKey ?? ""),
    enabled: outputKey !== null,
  });
  // Only this output's values: while the new output's load, the defaults.
  const values =
    outputKey !== null && data?.stageOutput === outputKey ? data : null;

  useEffect(() => {
    settings.set(values);
  }, [settings, values]);
  // The output whose values were last loaded; `undefined` before the first.
  const loadedOutput = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (values === null || values.stageOutput === "") return;
    const previous = loadedOutput.current;
    if (previous === values.stageOutput) return;
    loadedOutput.current = values.stageOutput;
    if (previous !== undefined && values.mics.length === 0) {
      onUncalibratedOutput?.();
    }
    // A new callback alone raises nothing: the output is the same.
  }, [values, onUncalibratedOutput]);
  // Values for an output no Stage shows any more are not kept.
  useEffect(
    () => () => {
      settings.set(null);
    },
    [settings],
  );
  return null;
}

const selectVolume = (live: LiveState) => live.volume;

/** The meters' range, in dBFS: a threshold line set by hand stays inside it. */
export const METER_RANGE_DBFS = { floor: -60, top: 0 } as const;

export interface MicThresholds {
  /**
   * The effective Mic threshold a meter draws for a Mic: what Start would
   * hand the scorer now, at the current OpenStar volume.
   */
  effectiveDbfs: (mic: MicKey | null) => number;
  /** What set that threshold: Calibration, a hand, or nothing (the default). */
  source: (mic: MicKey | null) => ThresholdSource;
  /**
   * Sets a Local mic's Mic threshold by hand to `effectiveDbfs` at the
   * current volume (kept inside the meter's range): saved at once, at the
   * reference volume, for the current Stage output. Does nothing while no
   * Stage output's values are loaded.
   */
  setByHand: (localMicId: string, effectiveDbfs: number) => void;
  /** Moves a Local mic's line by `stepDb` (±1 for the arrow keys). */
  nudge: (localMicId: string, stepDb: number) => void;
}

/**
 * A Stage's Mic thresholds for its meters, re-rendering on a volume step and
 * on newly loaded or hand-set values. The Mics screen and the Line-up seat
 * edit the one stored value through it, so a change in one shows in the
 * other. Hand settings go to the server as `setMicThreshold`.
 */
export function useMicThresholds(
  store: LiveStore,
  settings: StageMicSettings = stageMicSettings(),
): MicThresholds {
  // The default volume until the server tells it.
  const volume = useLive(selectVolume, store) ?? OPENSTAR_VOLUME.default;
  useSyncExternalStore(settings.subscribe, settings.values);
  const resolved = (mic: MicKey | null) =>
    seatMicSettings(mic, mic ? settings.storedFor(mic) : undefined, volume);
  const effectiveDbfs = (mic: MicKey | null) =>
    resolved(mic).effectiveThresholdDbfs;
  const setByHand = (localMicId: string, effective: number) => {
    const shown = Math.max(
      METER_RANGE_DBFS.floor,
      Math.min(METER_RANGE_DBFS.top, effective),
    );
    // Hundredths of a dB: no float noise in what is kept.
    const referenceDbfs =
      Math.round(atReferenceVolume(shown, volume) * 100) / 100;
    const stageOutput = settings.setByHand(localMicId, referenceDbfs);
    if (stageOutput === null) return;
    store.send({
      type: "setMicThreshold",
      stageOutput,
      localMicId,
      referenceDbfs,
    });
  };
  return {
    effectiveDbfs,
    source: (mic) => resolved(mic).thresholdSource,
    setByHand,
    nudge: (localMicId, stepDb) => {
      setByHand(
        localMicId,
        effectiveDbfs({ kind: "localMic", localMicId }) + stepDb,
      );
    },
  };
}
