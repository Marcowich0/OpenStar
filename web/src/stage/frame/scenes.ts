// Which full-screen scene the Stage shows ("Big moments", v1 spec #55): one
// scene per Stage state, chosen from the Party state the server sends, and
// what the frame around each scene allows.
//
// Adding a scene: add its id to `SceneId`, a line to `SCENE_RULES`, its
// component to `SCENES` in `sceneComponents.tsx` (both are exhaustive
// `Record`s, so tsc names every place), and the state that selects it to
// `pickScene` (with a test in `scenes.test.ts`).

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
 * The scene for the Stage state. `sing` and `results` are picked once the
 * Party state says a Song plays or has ended (#164, #182 add that state).
 */
export function pickScene(stage: StageState | null): SceneId {
  if (stage?.stageMoved) return "stageMoved";
  if (stage?.party?.head != null) return "lineUp";
  return "songBrowser";
}
