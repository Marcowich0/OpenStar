// Setup › Options on the Stage: the Stage options list (`OptionsList.tsx`)
// over the server's kept options. Every change is saved at once, with no
// Admin PIN, and kept for every Party.

import { t } from "../i18n/t";
import { OptionsList } from "./OptionsList";
import { useStageOptions } from "./useStageOptions";

export function OptionsScreen() {
  const { options, saveFailed, change } = useStageOptions();
  return (
    <div className="flex flex-col gap-8" data-testid="stage-options">
      <p className="text-2xl text-ink-2">{t("options.hint")}</p>
      {saveFailed && (
        <p role="alert" className="text-2xl font-semibold text-warn-fg">
          {t("options.saveFailed")}
        </p>
      )}
      <OptionsList options={options} onChange={change} />
    </div>
  );
}
