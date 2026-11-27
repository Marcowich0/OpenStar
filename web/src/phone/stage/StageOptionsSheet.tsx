// The Stage options on a Phone (#271): Options on the Stage tab opens the
// Stage's own list (`OptionsList`, compact) as a full-height sheet, with the
// same groups, folds, defaults and Resets. A change applies at once: it goes
// over the WebSocket as this Phone (`setStageOptions`), so the Stage toasts
// who changed what ("Sam changed Effects") and every browser refetches the
// options on the change notice. No Admin PIN.

import { useCallback, useState } from "react";

import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { OptionsList } from "../../stageOptions/OptionsList";
import type { StageOptions } from "../../stageOptions/stageOptions";
import {
  useStageOptions,
  type SaveStageOptions,
} from "../../stageOptions/useStageOptions";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

/** Options, under Check A/V sync, and its sheet. */
export function StageOptionsButton({ store }: { store: LiveStore }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        fill="white"
        className="w-full"
        onPress={() => {
          setOpen(true);
        }}
      >
        {t("stageTab.options")}
      </Button>
      <Sheet
        label={t("stageTab.options")}
        isOpen={open}
        onOpenChange={setOpen}
        fullScreen
      >
        {open && <StageOptionsBody store={store} />}
      </Sheet>
    </>
  );
}

function StageOptionsBody({ store }: { store: LiveStore }) {
  // The server answers with a change notice, not the options: what is kept
  // comes with the refetch it starts.
  const save: SaveStageOptions = useCallback(
    (options: StageOptions) =>
      store.send({ type: "setStageOptions", options })
        ? Promise.resolve(options)
        : Promise.reject(new Error("not connected")),
    [store],
  );
  const { options, saveFailed, change } = useStageOptions(save);
  return (
    <div className="flex flex-col gap-5" data-testid="phone-stage-options">
      <h2 className="text-3xl font-bold">{t("stageTab.options")}</h2>
      <p className="text-lg text-ink-2">{t("options.hint")}</p>
      {saveFailed && (
        <p role="alert" className="text-lg font-semibold text-warn-fg">
          {t("options.saveFailed")}
        </p>
      )}
      <OptionsList options={options} onChange={change} compact />
    </div>
  );
}
