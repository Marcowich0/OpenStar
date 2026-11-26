// The A/V offset (v1 spec #53): how much later the room hears this browser's
// sound than its screen shows it, in milliseconds. Positive means the sound
// arrives later than the picture. Drawing against Song time runs this much
// behind the clock (`songTime() − A/V offset`, in the sing screen's render
// loop and the Timing editor); the video, Pitch readings, Beats and the
// scorer never see it.
//
// The server keeps one value per (browser, output key) at
// `GET`/`PUT /api/av-offset`, with no Admin PIN. The browser is
// `stageBrowserId` (`mics/localMics.ts`), so the Stage and a Timing editor
// on the Stage PC share a value for the same output, while another browser
// keeps its own.

import { queryOptions } from "@tanstack/react-query";

import { api } from "../api/api";
import type { AvOffset } from "../generated/AvOffset";

/** Range, step and default, in ms (`crates/protocol/src/av_offset.rs`). */
export const AV_OFFSET = {
  minMs: -300,
  maxMs: 500,
  stepMs: 10,
  defaultMs: 0,
} as const;

/** `ms` brought within −300..+500 and onto the 10 ms grid. */
export function clampAvOffset(ms: number): number {
  if (!Number.isFinite(ms)) return AV_OFFSET.defaultMs;
  const onGrid = Math.round(ms / AV_OFFSET.stepMs) * AV_OFFSET.stepMs;
  // `+ 0` turns −0 into 0.
  return Math.min(AV_OFFSET.maxMs, Math.max(AV_OFFSET.minMs, onGrid)) + 0;
}

/** The key of one browser's A/V offset at one output. */
export function avOffsetKey(browser: string, output: string) {
  return ["avOffset", browser, output] as const;
}

/** `GET /api/av-offset`: this browser's value at `output` (0 if none). */
export function avOffsetQuery(browser: string, output: string) {
  return queryOptions({
    queryKey: avOffsetKey(browser, output),
    queryFn: ({ signal }) =>
      api("GET /api/av-offset", { query: { browser, output }, signal }),
  });
}

/** `PUT /api/av-offset`: stores `ms` (clamped first) and returns what is kept. */
export function saveAvOffset(
  browser: string,
  output: string,
  ms: number,
): Promise<AvOffset> {
  return api("PUT /api/av-offset", {
    body: { browser, output, avOffsetMs: clampAvOffset(ms) },
  });
}
