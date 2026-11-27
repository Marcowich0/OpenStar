// What the Stage and a Phone both use to read and keep Mic settings, free of
// any Stage module so the Phone's bundle can load it: the query of one Stage
// output's stored values, the meters' range, and how a hand setting is kept.

import { queryOptions } from "@tanstack/react-query";

import { api } from "../api/api";
import { atReferenceVolume } from "./micSettings";

/** `GET /api/mic-settings`: every Mic's values at one Stage output. */
export function stageOutputMicSettingsQuery(stageOutput: string) {
  return queryOptions({
    queryKey: ["micSettings", "stageOutput", stageOutput],
    queryFn: ({ signal }) =>
      api("GET /api/mic-settings", { query: { stageOutput }, signal }),
  });
}

/** The meters' range, in dBFS: a threshold line set by hand stays inside it. */
export const METER_RANGE_DBFS = { floor: -60, top: 0 } as const;

/**
 * The value a hand setting keeps for an effective Mic threshold `effective`
 * shown at OpenStar volume `volume`: kept inside the meters' range, at the
 * reference volume, in hundredths of a dB (no float noise in what is kept).
 * The Stage's meters and a Phone's own slider both keep it this way.
 */
export function handReferenceDbfs(effective: number, volume: number): number {
  const shown = Math.max(
    METER_RANGE_DBFS.floor,
    Math.min(METER_RANGE_DBFS.top, effective),
  );
  return Math.round(atReferenceVolume(shown, volume) * 100) / 100;
}
