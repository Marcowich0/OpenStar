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
   * Changes the fields in `change` and saves them at once; the screen shows
   * the change before the server answers. A refused save shows the kept
   * options again.
   */
  change: (change: Partial<StageOptions>) => void;
}

/**
 * Saves a change and answers with what is kept, or fails when it was not
 * saved. It is given the whole set after the change (`options`) and the
 * fields that changed (`change`): `PUT` stores the whole set, a Phone's
 * WebSocket command sends only the change, which names who changed them
 * (#271) and keeps another device's change to other options.
 */
export type SaveStageOptions = (
  options: StageOptions,
  change: Partial<StageOptions>,
) => Promise<StageOptions>;

export function useStageOptions(
  save: SaveStageOptions = saveStageOptions,
): UseStageOptions {
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
      save(next, fields).then(
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
    [client, save],
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
