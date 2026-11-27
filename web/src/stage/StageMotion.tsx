// The Stage's motion mode (#260): springs, or fades with reduced motion or
// with the Stage options' Effects off (`theme/motion.ts`).

import { useStageOptions } from "../stageOptions/useStageOptions";
import { effectsOff, MotionMode } from "../theme/motion";

/** Renders nothing; keeps the page's motion mode while the Stage is open. */
export function StageMotion() {
  const { options } = useStageOptions();
  return <MotionMode effectsOff={effectsOff(options)} />;
}
