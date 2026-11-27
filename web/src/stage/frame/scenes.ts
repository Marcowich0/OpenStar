// Which full-screen scene the Stage shows ("Big moments", v1 spec #55): one
// scene per Stage state, chosen from the Party state the server sends, and
// what the frame around each scene allows.
//
// Adding a scene: add its id to `SceneId`, a line to `SCENE_RULES`, its
// component to `SCENES` in `sceneComponents.tsx` (both are exhaustive
// `Record`s, so tsc names every place), and the state that selects it to
// `pickScene` (with a test in `scenes.test.ts`).

import type { RequestId } from "../../generated/RequestId";
import type { StageState } from "../../live/liveState";

export type SceneId =
  "songBrowser" | "lineUp" | "sing" | "results" | "stageMoved";

export interface SceneRules {
  /** The pill row (Songs · Queue · People) in the top right. */
  pillRow: boolean;
  /** The Setup pill in the pill row. */
  setup: boolean;
  /** `S`, `Q`, `P` and the pills may open an overlay. */
  overlays: boolean;
}

export const SCENE_RULES: Record<SceneId, SceneRules> = {
  songBrowser: { pillRow: true, setup: true, overlays: true },
  lineUp: { pillRow: true, setup: true, overlays: true },
  // No pill row and no overlay while a Song plays.
  sing: { pillRow: false, setup: false, overlays: false },
  results: { pillRow: true, setup: false, overlays: true },
  // The old Stage only offers to become the Stage again.
  stageMoved: { pillRow: false, setup: false, overlays: false },
};

/**
 * The scene for the Stage state, from the Party state the server sends:
 * the results of the Song that just ended, else the sing screen while the
 * head's Song plays (paused or not), else the head's waiting Line-up, else
 * the song browser.
 */
export function pickScene(stage: StageState | null): SceneId {
  if (stage?.stageMoved) return "stageMoved";
  const party = stage?.party;
  if (party?.results != null) return "results";
  if (party?.playing != null) return "sing";
  if (party?.head != null) return "lineUp";
  return "songBrowser";
}

/**
 * The scene the Stage shows, with its own "browsing" choice on top of the
 * server's: `browsing` is the head whose Line-up the Stage set aside for the
 * song browser (the Line-up's Browse songs, or `H`). It holds only while
 * the server's scene is still that same head's Line-up. A Song that starts,
 * its results, Stage moved here, an empty Queue or a different head (a
 * Request removed, skipped or played next) all end it, so a Stage left on
 * the song browser comes back to the Line-up the Phones are filling.
 */
export function browsedScene(
  scene: SceneId,
  stage: StageState | null,
  browsing: RequestId | null,
): { scene: SceneId; browsing: RequestId | null } {
  const holds =
    browsing !== null && scene === "lineUp" && stage?.party?.head === browsing;
  return holds ? { scene: "songBrowser", browsing } : { scene, browsing: null };
}
