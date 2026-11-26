// The Stage's A/V offset: this Stage browser's value at its current output
// (`useStageOutput`). When the output changes, that output's value is loaded
// (0 when none is kept). The sing scene passes `seconds` to the render loop.

import { useAvOffset, type BrowserAvOffset } from "../../avOffset/useAvOffset";
import { useStageOutput } from "./StageOutput";

export type StageAvOffset = BrowserAvOffset;

export function useStageAvOffset(): StageAvOffset {
  const { stageBrowser, outputKey } = useStageOutput();
  return useAvOffset(stageBrowser, outputKey);
}
