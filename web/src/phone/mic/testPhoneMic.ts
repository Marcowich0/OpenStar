// Tests only: what a fake Phone mic's `diagnostics()` returns, a mic that
// is off and has heard nothing.

import { createFrameStats } from "../../pitch/capture/micDiagnostics";
import type { PhoneMicDiagnostics } from "./phoneMic";

export function quietDiagnostics(): PhoneMicDiagnostics {
  return {
    takenAt: "2026-11-27T00:00:00.000Z",
    state: "off",
    processing: "standard",
    capture: null,
    frames: createFrameStats(-30).summary(0),
    clockOffsetMs: null,
    detector: null,
    wakeLock: false,
    hidden: false,
    stage: null,
    stageReportAgeMs: null,
  };
}
