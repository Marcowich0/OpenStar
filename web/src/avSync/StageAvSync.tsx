// Check A/V sync on the Stage (#163), the Setup menu's overlay: the clicks
// play on the Stage's one AudioContext, into its gain chain after the Song
// gain; ←/→ on the Stage and each Remote's −/+ or Reset (relayed by the
// server) step this Stage browser's A/V offset at its current output, saved
// at once. Done or closing the overlay ends the check for every browser
// (`StageFrame` sends `endAvSync`); the frame opens and closes this overlay
// as the server says the check runs. Once its value has loaded, and after
// every change, the Stage tells the server, which shows it on every Remote
// (#168). While a connected Mic bridge sees an interface not in Pro Audio
// (as the server lists it), it says to switch profiles before calibrating
// (#206): switching later would mean calibrating again.

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { micBridgesQuery } from "../api/queries";
import type { MicBridges } from "../generated/MicBridges";

import { t } from "../i18n/t";
import { useStageFrame, useStageKeys } from "../stage/frame/stageFrameContext";
import { useStageAvOffset } from "../stage/output/useStageAvOffset";
import { stageAudio } from "../stage/playback/stageAudio";
import { AvSyncPanel, useAvSyncValue, useClickTrack } from "./AvSyncPanel";

/** Whether an open bridge sees an interface that is not in Pro Audio. */
export function profileSwitchPending(listing: MicBridges | undefined): boolean {
  return (
    listing?.bridges.some(
      (bridge) => bridge.open && (bridge.notProAudio ?? []).length > 0,
    ) ?? false
  );
}

export function StageAvSync() {
  const switchFirst = profileSwitchPending(useQuery(micBridgesQuery).data);
  const { store, closeOverlay } = useStageFrame();
  const offset = useStageAvOffset();
  const { ms, step } = useAvSyncValue(offset);
  const landings = useClickTrack(stageAudio());

  useEffect(() => store.onAvSyncStep(step), [store, step]);
  // Not the 0 shown while the kept value loads.
  const known = offset.loaded || ms !== offset.ms;
  useEffect(() => {
    if (known) store.send({ type: "reportAvSyncOffset", avOffsetMs: ms });
  }, [store, known, ms]);
  useStageKeys({
    ArrowLeft: () => {
      step("down");
    },
    ArrowRight: () => {
      step("up");
    },
  });

  return (
    <>
      {switchFirst && (
        <p
          role="alert"
          className="rounded-card bg-surface px-8 py-5 text-center text-2xl font-semibold"
        >
          {t("avSync.switchProfiles")}
        </p>
      )}
      <AvSyncPanel
        ms={ms}
        landings={landings}
        onStep={step}
        onDone={closeOverlay}
        hint={t("avSync.stageHint")}
      />
    </>
  );
}
