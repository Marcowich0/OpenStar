// What each overlay shows, and the overlay itself: a veil over the whole
// screen and a cream modal (44 px radius) in the reference frame. Songs and
// Queue are `../overlays/`; People is a placeholder until its ticket fills it.
// Mics is `mics/MicsScreen.tsx`, Calibrate mics
// `calibration/StageCalibration.tsx`, Check A/V sync `avSync/StageAvSync.tsx`.

import { useId, type ComponentType } from "react";

import { t, type MessageKey } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { StageAvSync } from "../../avSync/StageAvSync";
import { StageCalibration } from "../../calibration/StageCalibration";
import { MicsScreen } from "../../mics/MicsScreen";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import { QueueOverlay } from "../overlays/QueueOverlay";
import { SongsOverlay } from "../overlays/SongsOverlay";
import type { OverlayId } from "./overlayIds";
import { ReferenceBox } from "./ReferenceBox";
import { StageLayer, useStageFrame } from "./stageFrameContext";

export interface OverlayDefinition {
  title: MessageKey;
  component: ComponentType;
}

const selectParty = (live: LiveState) => live.stage?.party ?? null;

function PeopleOverlay() {
  const { store } = useStageFrame();
  const party = useLive(selectParty, store);
  return (
    <div className="flex flex-col gap-8">
      <p className="text-3xl text-ink-2">
        {t("stage.people.count", { count: party?.members.length ?? 0 })}
      </p>
      <div className="flex items-center justify-between gap-6">
        <p className="text-3xl font-semibold" data-testid="people-join-code">
          {party ? t("stage.people.joinCode", { code: party.joinCode }) : null}
        </p>
        <HoldButton
          fill="ink"
          onHold={() => {
            store.send({ type: "newParty" });
          }}
        >
          {t("stage.newParty")}
        </HoldButton>
      </div>
    </div>
  );
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
              className="inline-flex size-16 cursor-pointer items-center justify-center rounded-full bg-white shadow-ledge-sm"
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
