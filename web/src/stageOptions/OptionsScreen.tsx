// Setup › Options on the Stage: the Stage options list (`OptionsList.tsx`)
// over the server's kept options. Every change is saved at once, with no
// Admin PIN, and kept for every Party. Its OpenStar volume row is bound to
// the Stage's live connection, like the +/− keys.

import { t } from "../i18n/t";
import type { LiveStore } from "../live/liveStore";
import { useOpenStarVolume } from "../live/useOpenStarVolume";
import { useStageFrame } from "../stage/frame/stageFrameContext";
import { OptionsList } from "./OptionsList";
import { useStageOptions } from "./useStageOptions";

/** The Options overlay, on the Stage's own connection. */
export function OptionsScreen() {
  const { store } = useStageFrame();
  return <OptionsPanel store={store} />;
}

export function OptionsPanel({ store }: { store: LiveStore }) {
  const { options, saveFailed, change } = useStageOptions();
  const openStarVolume = useOpenStarVolume(store);
  return (
    <div className="flex flex-col gap-8" data-testid="stage-options">
      <p className="text-2xl text-ink-2">{t("options.hint")}</p>
      {saveFailed && (
        <p role="alert" className="text-2xl font-semibold text-warn-fg">
          {t("options.saveFailed")}
        </p>
      )}
      <OptionsList
        options={options}
        onChange={change}
        openStarVolume={openStarVolume}
      />
    </div>
  );
}
