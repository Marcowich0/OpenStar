// Stage moved here: the old Stage after another browser took over, with a
// held "Make this the Stage again". (#186 adds the Admin PIN step for a
// browser that has not become the Stage with the PIN.)

import { t } from "../../i18n/t";
import { HoldButton } from "../../ui/HoldButton";
import { useStageFrame } from "../frame/stageFrameContext";

export function StageMovedScene() {
  const { takeStageBack } = useStageFrame();
  return (
    <section
      className="flex h-full flex-col items-center justify-center gap-10 px-60 text-center"
      data-testid="stage-moved"
    >
      <h1 className="text-8xl font-bold">{t("stage.moved.title")}</h1>
      <p className="max-w-[1100px] text-4xl text-ink-2">
        {t("stage.moved.body")}
      </p>
      <HoldButton fill="ink" onHold={takeStageBack} className="mt-6">
        {t("stage.takeBack")}
      </HoldButton>
    </section>
  );
}
