// The OpenStar volume on the Stage tab (v1 spec #49, "Stage tab"), in every
// state, a Song included: − and + around the value, 0 to 100 in steps of 5,
// with no Admin PIN. Each press asks the server for one step of the Stage's
// one volume (the same value the Stage's own +/− keys set); the value shown
// is always the server's, so every Remote shows the same, as does the Sound
// group's row in Options (`useOpenStarVolume`).

import type { VolumeStep } from "../../generated/VolumeStep";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { useOpenStarVolume } from "../../live/useOpenStarVolume";
import { OPENSTAR_VOLUME } from "../../playback/gain";
import { Icon } from "../../ui/Icon";

const STEP_BUTTON =
  "flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink-fill text-white shadow-ledge-ink outline-none focus-visible:outline-4 focus-visible:outline-yellow disabled:cursor-not-allowed disabled:opacity-45";

export function VolumeControl({ store }: { store: LiveStore }) {
  // `null` until a Stage has reported its output: nothing to step yet.
  const { volume, step: stepVolume } = useOpenStarVolume(store);
  const step = (direction: VolumeStep) => () => {
    stepVolume(direction);
  };

  return (
    <div
      role="group"
      aria-label={t("stageTab.volume")}
      className="flex items-center gap-3 rounded-card-sm bg-surface px-4 py-3 shadow-ledge-sm"
    >
      <span className="grow text-lg font-semibold">{t("stageTab.volume")}</span>
      <button
        type="button"
        aria-label={t("stageTab.volumeDown")}
        disabled={volume === null || volume <= OPENSTAR_VOLUME.min}
        onClick={step("down")}
        className={STEP_BUTTON}
      >
        <Icon name="minus" className="size-6" />
      </button>
      <span className="w-12 text-center text-2xl font-bold tabular-nums">
        {volume ?? t("stageTab.volumeUnknown")}
      </span>
      <button
        type="button"
        aria-label={t("stageTab.volumeUp")}
        disabled={volume === null || volume >= OPENSTAR_VOLUME.max}
        onClick={step("up")}
        className={STEP_BUTTON}
      >
        <Icon name="plus" className="size-6" />
      </button>
    </div>
  );
}
