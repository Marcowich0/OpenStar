// The component for each scene. A `fullScreen` scene fills the screen itself
// (the sing scene's video and canvases); any other scene is drawn in the
// 1920 × 1080 reference frame.

import type { ComponentType } from "react";

import { LineUpScene } from "../scenes/lineUp/LineUpScene";
import { ResultsScene } from "../scenes/results/ResultsScene";
import { SingScene } from "../scenes/sing/SingScene";
import { SongBrowserScene } from "../scenes/SongBrowserScene";
import { StageMovedScene } from "../scenes/StageMovedScene";
import type { SceneId } from "./scenes";

export interface SceneDefinition {
  component: ComponentType;
  fullScreen?: boolean;
}

export const SCENES: Record<SceneId, SceneDefinition> = {
  songBrowser: { component: SongBrowserScene },
  lineUp: { component: LineUpScene },
  sing: { component: SingScene, fullScreen: true },
  results: { component: ResultsScene },
  stageMoved: { component: StageMovedScene },
};
