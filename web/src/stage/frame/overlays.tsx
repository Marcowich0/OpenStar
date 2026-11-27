// What each overlay shows, and the overlay itself: a veil over the whole
// screen and a cream modal (44 px radius) in the reference frame. Songs,
// Queue and People are `../overlays/`. Mics is `mics/MicsScreen.tsx`,
// Calibrate mics `calibration/StageCalibration.tsx`, Check A/V sync
// `avSync/StageAvSync.tsx`, Downloads `../overlays/DownloadsOverlay.tsx` (the
// Admin area's Downloads section), Options `stageOptions/OptionsScreen.tsx`.
// The Song detail is `../overlays/SongDetailOverlay.tsx`.

import { useId, type ComponentType } from "react";

import { t, type MessageKey } from "../../i18n/t";
import { StageAvSync } from "../../avSync/StageAvSync";
import { StageCalibration } from "../../calibration/StageCalibration";
import { MicsScreen } from "../../mics/MicsScreen";
import { OptionsScreen } from "../../stageOptions/OptionsScreen";
import { Icon } from "../../ui/Icon";
import { DownloadsOverlay } from "../overlays/DownloadsOverlay";
import { PeopleOverlay } from "../overlays/PeopleOverlay";
import { QueueOverlay } from "../overlays/QueueOverlay";
import { SongDetailOverlay } from "../overlays/SongDetailOverlay";
import { SongsOverlay } from "../overlays/SongsOverlay";
import type { OverlayId } from "./overlayIds";
import { ReferenceBox } from "./ReferenceBox";
import { StageLayer, useStageFrame } from "./stageFrameContext";

export interface OverlayDefinition {
  title: MessageKey;
  component: ComponentType;
}

export const OVERLAYS: Record<OverlayId, OverlayDefinition> = {
  songs: { title: "stage.overlay.songs", component: SongsOverlay },
  queue: { title: "stage.overlay.queue", component: QueueOverlay },
  people: { title: "stage.overlay.people", component: PeopleOverlay },
  mics: { title: "stage.overlay.mics", component: MicsScreen },
  calibrateMics: {
    title: "stage.overlay.calibrateMics",
    component: StageCalibration,
  },
  avSync: { title: "stage.overlay.avSync", component: StageAvSync },
  downloads: { title: "stage.overlay.downloads", component: DownloadsOverlay },
  options: { title: "stage.overlay.options", component: OptionsScreen },
  songDetail: {
    title: "stage.overlay.songDetail",
    component: SongDetailOverlay,
  },
};

/** The open overlay: veil, modal, heading and close control. */
export function StageOverlay({ id }: { id: OverlayId }) {
  const { closeOverlay } = useStageFrame();
  const headingId = useId();
  const { title, component: Content } = OVERLAYS[id];
  return (
    <div className="absolute inset-0 z-40" data-overlay={id}>
      <div
        aria-hidden="true"
        data-testid="overlay-veil"
        className="absolute inset-0 bg-veil"
        onClick={closeOverlay}
      />
      <ReferenceBox passThrough>
        <StageLayer
          onDismiss={closeOverlay}
          role="dialog"
          aria-modal
          aria-labelledby={headingId}
          className="pointer-events-auto absolute top-1/2 left-1/2 flex max-h-[960px] w-[1300px] -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col gap-6 overflow-auto rounded-card bg-cream p-9 text-ink shadow-ledge-lg"
        >
          <div className="flex items-center justify-between gap-6">
            <h2 id={headingId} className="text-4xl font-bold">
              {t(title)}
            </h2>
            <button
              type="button"
              aria-label={t("stage.overlay.close")}
              onClick={closeOverlay}
              className="inline-flex size-16 cursor-pointer items-center justify-center rounded-full bg-surface shadow-ledge-sm"
            >
              <Icon name="close" className="size-8" />
            </button>
          </div>
          <Content />
        </StageLayer>
      </ReferenceBox>
    </div>
  );
}
