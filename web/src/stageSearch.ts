/** The search parameters of the Stage route `/stage` (#227). */
export interface StageSearch {
  /** `?perf`: the frame-time overlay on the sing screen. */
  perf?: true | undefined;
  /**
   * `?perf&lanes=8`: the sing screen draws this many synthetic lanes, fed by
   * recorded Pitch readings, instead of the Line-up's. Only with `perf`.
   */
  lanes?: number | undefined;
}

/** The most lanes the sing screen lays out (`MAX_LANES` in `stage/sing/laneLayout.ts`). */
export const MAX_SYNTHETIC_LANES = 8;

/**
 * Keeps `perf` (present, with any value but `false`) and a whole `lanes`
 * from 1 to 8 beside it; drops anything else. The router merges the raw
 * search into what this returns, so a dropped value is returned as
 * `undefined` to override it.
 */
export function validateStageSearch(
  search: Record<string, unknown>,
): StageSearch {
  const raw = search["perf"];
  const perf = raw !== undefined && raw !== false && raw !== "false";
  if (!perf) return { perf: undefined, lanes: undefined };
  // The router JSON-parses search values, so `lanes=8` arrives as a number.
  const lanes = Number(search["lanes"]);
  const valid =
    Number.isInteger(lanes) && lanes >= 1 && lanes <= MAX_SYNTHETIC_LANES;
  return { perf: true, lanes: valid ? lanes : undefined };
}
