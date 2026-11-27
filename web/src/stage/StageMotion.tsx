// The Stage's motion mode (#260): springs, or fades with reduced motion or
// with the Stage options' Effects off (`effectsOff`, `theme/motion.ts`).

import { effectsOff } from "../stageOptions/stageOptions";
import { useStageOptions } from "../stageOptions/useStageOptions";
import { MotionMode } from "../theme/motion";

/** Renders nothing; keeps the page's motion mode while the Stage is open. */
export function StageMotion() {
  const { options } = useStageOptions();
  return <MotionMode effectsOff={effectsOff(options)} />;
}
