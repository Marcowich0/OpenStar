// The pause menu (#217, v1 spec #55 "Pause menu"): a veil of ink at 55 % over
// the frozen sing screen and a white card headed "Paused". Resume (green, the
// default focus) runs the 3-2-1 countdown; Restart, Skip and End need a hold.
// Esc on the menu resumes: the menu is a Stage layer, and Esc dismisses the
// top layer. The sing scene shows it whenever the Song is paused, whoever
// paused it, and sends each choice through the server like any Remote.

import { useId } from "react";

import { t } from "../../../i18n/t";
import { Button } from "../../../ui/Button";
import { HoldButton } from "../../../ui/HoldButton";
import { Icon } from "../../../ui/Icon";
import { ReferenceBox } from "../../frame/ReferenceBox";
import { StageLayer } from "../../frame/stageFrameContext";
import { ByInput } from "../../input/KeyHint";

export type PauseMenuControl = "resume" | "restart" | "skip" | "end";

export function PauseMenu({
  onControl,
}: {
  onControl: (control: PauseMenuControl) => void;
}) {
  const titleId = useId();
  return (
    <StageLayer
      onDismiss={() => {
        onControl("resume");
      }}
      role="dialog"
      aria-modal
      aria-labelledby={titleId}
      className="absolute inset-0 bg-ink/55"
    >
      <ReferenceBox>
        <div className="flex h-full items-center justify-center">
          <div
            data-testid="pause-menu"
            className="flex w-[620px] flex-col gap-6 rounded-card bg-white px-14 pt-12 pb-14 text-ink shadow-ledge-lg"
          >
            <h2 id={titleId} className="text-center text-6xl font-bold">
              {t("stage.pause.title")}
            </h2>
            <div data-stage-default className="flex flex-col">
              <Button
                fill="green"
                className="w-full"
                onPress={() => {
                  onControl("resume");
                }}
              >
                <Icon name="play" />
                {t("stage.pause.resume")}
              </Button>
            </div>
            <HoldButton
              className="w-full"
              onHold={() => {
                onControl("restart");
              }}
            >
              <Icon name="restart" />
              {t("stage.pause.restart")}
            </HoldButton>
            <HoldButton
              className="w-full"
              onHold={() => {
                onControl("skip");
              }}
            >
              <Icon name="skip" />
              {t("stage.pause.skip")}
            </HoldButton>
            <HoldButton
              fill="red"
              className="w-full"
              onHold={() => {
                onControl("end");
              }}
            >
              <Icon name="stop" />
              {t("stage.pause.end")}
            </HoldButton>
            <p className="text-center text-xl text-ink-2">
              <ByInput
                keys={t("stage.pause.hint")}
                pad={t("stage.pause.hint.pad")}
              />
            </p>
          </div>
        </div>
      </ReferenceBox>
    </StageLayer>
  );
}
