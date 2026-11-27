// The Stage's performance check tools (#227), loaded only with `?perf`: the
// frame-time overlay and the synthetic lanes with their recorded readings
// (about 700 KB of JSON), so neither grows the normal Stage's code.

import type { SongClock } from "../../clock/songClock";
import type { SingState } from "../sing/frame";
import {
  createSyntheticLanes,
  readingsRuns,
  type ReadingsRun,
  type SyntheticLanes,
} from "./syntheticLanes";

export { FrameTimeOverlay } from "./FrameTimeOverlay";

const files = import.meta.glob<string>(
  "../../../../fixtures/readings/run-*.json",
  { query: "?raw", import: "default", eager: true },
);

let singing: ReadingsRun[] | null = null;

/**
 * `count` synthetic lanes over the Song of `base`, fed by the recorded
 * singing runs (a Bleed run's readings stay under the Mic threshold, so its
 * lane would draw no pitch line and measure less than a sung one).
 */
export function syntheticLanes(
  base: SingState,
  clock: Pick<SongClock, "songTimeAt" | "playingAt" | "lastSeekAt">,
  count: number,
): SyntheticLanes {
  singing ??= readingsRuns(files).filter((run) => run.kind === "singing");
  return createSyntheticLanes({
    base,
    count,
    runs: singing,
    clock,
    now: () => performance.now(),
  });
}
