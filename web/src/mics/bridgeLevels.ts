// Mic bridge meter levels on the Stage (v1 spec #51): each open bridge sends
// its channels' levels ten times a second, and the server relays them as
// `localMicLevels`. They are kept here, outside React, so a meter reads the
// latest one every frame without a render. A level the bridge has stopped
// sending (its channel is no longer metered, or the bridge closed) is
// forgotten after `LEVEL_STALE_MS`, and the meter falls to silence. Each level
// also says whether its interval was exact digital silence, for the "sends no
// sound" warning (`silentLocalMics.ts`).

import type { LocalMicLevel } from "../generated/LocalMicLevel";

/** How long a level counts after it arrived: five missed updates. */
export const LEVEL_STALE_MS = 500;

/** A level as kept: a Phone's loudness has no digital-silence flag. */
export type KeptLevel = Pick<LocalMicLevel, "localMicId" | "levelDbfs"> &
  Partial<Pick<LocalMicLevel, "digitalSilence">>;

export interface BridgeLevels {
  /** Levels that arrived at `now` (ms). */
  receive: (levels: readonly KeptLevel[], now: number) => void;
  /** A Local mic's latest level in dBFS, or `null` if none counts at `now`. */
  levelDbfs: (localMicId: string, now: number) => number | null;
  /**
   * Whether a Local mic's latest level was exact digital silence, or `null`
   * if none counts at `now`.
   */
  digitalZero: (localMicId: string, now: number) => boolean | null;
}

export function createBridgeLevels(): BridgeLevels {
  const latest = new Map<
    string,
    { levelDbfs: number; zero: boolean; at: number }
  >();
  const fresh = (localMicId: string, now: number) => {
    const level = latest.get(localMicId);
    return level && now - level.at <= LEVEL_STALE_MS ? level : null;
  };
  return {
    receive(levels, now) {
      for (const { localMicId, levelDbfs, digitalSilence = false } of levels)
        latest.set(localMicId, { levelDbfs, zero: digitalSilence, at: now });
    },
    levelDbfs: (localMicId, now) => fresh(localMicId, now)?.levelDbfs ?? null,
    digitalZero: (localMicId, now) => fresh(localMicId, now)?.zero ?? null,
  };
}
