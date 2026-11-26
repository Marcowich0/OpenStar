// A browser's A/V offset at its current output, for whoever draws against
// Song time on that browser: the Stage's sing screen (`useStageAvOffset`) and
// the Timing editor (#57/#220, with this browser's `stageBrowserId` and its
// own output key from a `createStageOutputWatcher`).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  AV_OFFSET,
  avOffsetKey,
  avOffsetQuery,
  saveAvOffset,
} from "./avOffset";

export interface BrowserAvOffset {
  /** The value in ms; 0 while the output is unknown or still loading. */
  ms: number;
  /**
   * The value in seconds, read when called: give it as the render loop's
   * `avOffset` getter, so a new value applies from the next frame.
   */
  seconds: () => number;
  /** Stores a new value (clamped to the range and grid) for this output. */
  save: (ms: number) => Promise<void>;
}

export function useAvOffset(
  browser: string | null,
  output: string | null,
): BrowserAvOffset {
  const client = useQueryClient();
  const known = browser !== null && output !== null;
  const { data } = useQuery({
    ...avOffsetQuery(browser ?? "", output ?? ""),
    enabled: known,
  });
  // Never the previous output's value while a new one loads.
  const ms = known
    ? (data?.avOffsetMs ?? AV_OFFSET.defaultMs)
    : AV_OFFSET.defaultMs;
  const latest = useRef(ms);
  useEffect(() => {
    latest.current = ms;
  }, [ms]);
  const seconds = useCallback(() => latest.current / 1000, []);
  const save = useCallback(
    async (next: number) => {
      if (browser === null || output === null) return;
      const kept = await saveAvOffset(browser, output, next);
      client.setQueryData(avOffsetKey(browser, output), kept);
    },
    [client, browser, output],
  );
  return { ms, seconds, save };
}
