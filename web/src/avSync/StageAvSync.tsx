// Check A/V sync on the Stage (#163), the Setup menu's overlay: the clicks
// play on the Stage's one AudioContext, into its gain chain after the Song
// gain; ←/→ on the Stage and each Remote's −/+ or Reset (relayed by the
// server) step this Stage browser's A/V offset at its current output, saved
// at once. Done or closing the overlay ends the check for every browser
// (`StageFrame` sends `endAvSync`); the frame opens and closes this overlay
// as the server says the check runs.

import { useEffect } from "react";

import { t } from "../i18n/t";
import { useStageFrame, useStageKeys } from "../stage/frame/stageFrameContext";
import { useStageAvOffset } from "../stage/output/useStageAvOffset";
import { stageAudio } from "../stage/playback/stageAudio";
import { AvSyncPanel, useAvSyncValue, useClickTrack } from "./AvSyncPanel";

export function StageAvSync() {
  const { store, closeOverlay } = useStageFrame();
  const { ms, step } = useAvSyncValue(useStageAvOffset());
  const landings = useClickTrack(stageAudio());

  useEffect(() => store.onAvSyncStep(step), [store, step]);
  useStageKeys({
    ArrowLeft: () => {
      step("down");
    },
    ArrowRight: () => {
      step("up");
    },
  });

  return (
    <AvSyncPanel
      ms={ms}
      landings={landings}
      onStep={step}
      onDone={closeOverlay}
      hint={t("avSync.stageHint")}
    />
  );
}
