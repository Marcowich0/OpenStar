// The Stage options in React: `useStageOptions` reads them (the defaults
// until they load) and saves a change, and `StageOptionsLoader` keeps the
// Stage's holder (`stageOptions()`) filled for the code outside React. The
// query refetches after every `stageOptions` change notice.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  saveStageOptions,
  STAGE_OPTIONS,
  stageOptions,
  stageOptionsKey,
  stageOptionsQuery,
  type StageOptions,
  type StageOptionsHolder,
} from "./stageOptions";

export interface UseStageOptions {
  /** The kept options, or the defaults while they load. */
  options: StageOptions;
  loaded: boolean;
  /** The last save was refused or got no answer (cleared by the next one). */
  saveFailed: boolean;
  /**
   * Changes the fields in `change` and saves the whole set at once; the
   * screen shows the change before the server answers.
   */
  change: (change: Partial<StageOptions>) => void;
}

export function useStageOptions(): UseStageOptions {
  const client = useQueryClient();
  const { data } = useQuery(stageOptionsQuery);
  const [saveFailed, setSaveFailed] = useState(false);
  const change = useCallback(
    (fields: Partial<StageOptions>) => {
      // From the latest copy, so quick presses add up.
      const before =
        client.getQueryData<StageOptions>(stageOptionsKey) ??
        STAGE_OPTIONS.defaults;
      const next = { ...before, ...fields };
      client.setQueryData(stageOptionsKey, next);
      setSaveFailed(false);
      saveStageOptions(next).then(
        (kept) => {
          if (client.getQueryData(stageOptionsKey) === next) {
            client.setQueryData(stageOptionsKey, kept);
          }
        },
        () => {
          setSaveFailed(true);
          void client.invalidateQueries({ queryKey: stageOptionsKey });
        },
      );
    },
    [client],
  );
  return {
    options: data ?? STAGE_OPTIONS.defaults,
    loaded: data !== undefined,
    saveFailed,
    change,
  };
}

/** Keeps the Stage's holder filled while the Stage is open. Renders nothing. */
export function StageOptionsLoader({
  holder = stageOptions(),
}: {
  /** Tests only: the holder to fill. */
  holder?: StageOptionsHolder;
}) {
  const { data } = useQuery(stageOptionsQuery);
  useEffect(() => {
    holder.set(data ?? null);
  }, [holder, data]);
  return null;
}
