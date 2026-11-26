// Keeps the Stage's Mic settings holder (`stageMicSettings.ts`) filled with
// the values stored for the current Stage output: loaded when the Stage
// opens, again when the output key changes, and after every `micSettings`
// change notice (a Calibration run or a hand setting stored), since the
// query's key starts with that topic's prefix. `StageScreen` mounts it inside
// `StageOutputProvider`. It renders nothing.

import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { api } from "../api/api";
import type { MicKey } from "../generated/MicKey";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { OPENSTAR_VOLUME } from "../playback/gain";
import { useStageOutput } from "../stage/output/StageOutput";
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
}: {
  /** Tests only: the output key (by default the Stage output's). */
  outputKey?: string | null;
  /** Tests only: the holder to fill. */
  settings?: StageMicSettings;
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

/**
 * The effective Mic threshold a meter draws for a Mic: what Start would hand
 * the scorer now, at the current OpenStar volume (the default volume until
 * the server tells it). Re-renders on a volume step and on newly loaded
 * values.
 */
export function useMicThresholds(
  store: LiveStore,
  settings: StageMicSettings = stageMicSettings(),
): (mic: MicKey | null) => number {
  const volume = useLive(selectVolume, store) ?? OPENSTAR_VOLUME.default;
  useSyncExternalStore(settings.subscribe, settings.values);
  return (mic) =>
    seatMicSettings(mic, mic ? settings.storedFor(mic) : undefined, volume)
      .effectiveThresholdDbfs;
}
