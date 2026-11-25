// Mic bridge meter levels on the Stage (v1 spec #51): each open bridge sends
// its channels' levels ten times a second, and the server relays them as
// `localMicLevels`. They are kept here, outside React, so a meter reads the
// latest one every frame without a render. A level the bridge has stopped
// sending (its channel is no longer metered, or the bridge closed) is
// forgotten after `LEVEL_STALE_MS`, and the meter falls to silence.

import type { LocalMicLevel } from "../generated/LocalMicLevel";

/** How long a level counts after it arrived: five missed updates. */
export const LEVEL_STALE_MS = 500;

export interface BridgeLevels {
  /** Levels that arrived at `now` (ms). */
  receive: (levels: readonly LocalMicLevel[], now: number) => void;
  /** A Local mic's latest level in dBFS, or `null` if none counts at `now`. */
  levelDbfs: (localMicId: string, now: number) => number | null;
}

export function createBridgeLevels(): BridgeLevels {
  const latest = new Map<string, { levelDbfs: number; at: number }>();
  return {
    receive(levels, now) {
      for (const { localMicId, levelDbfs } of levels)
        latest.set(localMicId, { levelDbfs, at: now });
    },
    levelDbfs(localMicId, now) {
      const level = latest.get(localMicId);
      return level && now - level.at <= LEVEL_STALE_MS
        ? level.levelDbfs
        : null;
    },
  };
}
