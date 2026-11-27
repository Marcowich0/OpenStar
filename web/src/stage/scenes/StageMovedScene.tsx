// Stage moved here (v1 spec #55): the old Stage after another browser took
// over, with a held "Make this the Stage again". A remembered Stage browser
// takes the Stage back with the hold alone; any other browser (the server was
// restarted with a new Admin PIN, say) is shown the Admin PIN pad after the
// hold, and takes the Stage back once the PIN is accepted.

import { useEffect, useState } from "react";

import { stageTrust } from "../../live/browserLive";
import type { StageTrust } from "../../live/stageTrust";
import { t } from "../../i18n/t";
import { AdminPinDialog } from "../../pin/AdminPinDialog";
import { HoldButton } from "../../ui/HoldButton";
import { useStageFrame } from "../frame/stageFrameContext";

/** `null` while the server has not said, or could not be reached. */
type Remembered = boolean | null;

function useRemembered(trust: StageTrust): Remembered {
  const [remembered, setRemembered] = useState<Remembered>(null);
  useEffect(() => {
    let live = true;
    void trust.isRemembered().then((answer) => {
      if (live) setRemembered(answer);
    });
    return () => {
      live = false;
    };
  }, [trust]);
  return remembered;
}

export function StageMovedScene() {
  const { takeStageBack } = useStageFrame();
  const trust = stageTrust();
  const remembered = useRemembered(trust);
  const [padOpen, setPadOpen] = useState(false);

  return (
    <section
      className="flex h-full flex-col items-center justify-center gap-7 px-60 text-center"
      data-testid="stage-moved"
    >
      <MovedTv />
      <h1 className="text-8xl leading-none font-bold">
        {t("stage.moved.title")}
      </h1>
      <p className="max-w-[1100px] text-4xl text-ink-2">
        {t("stage.moved.body")}
      </p>
      <HoldButton
        fill="ink"
        onHold={() => {
          // Asked again: the cookie may be gone since the scene opened.
          // Unknown (no answer): reloading asks again, and the Stage trust
          // gate shows the pad if it is needed.
          void trust.isRemembered().then((now) => {
            if (now === false) setPadOpen(true);
            else takeStageBack();
          });
        }}
        className="mt-6"
      >
        {t("stage.takeBack")}
      </HoldButton>
      {remembered !== null && (
        <p className="text-2xl text-ink-2">
          {t(remembered ? "stage.moved.knowsPin" : "stage.moved.needsPin")}
        </p>
      )}
      <AdminPinDialog
        isOpen={padOpen}
        onOpenChange={setPadOpen}
        onSuccess={takeStageBack}
        check={trust.giveAdminPin}
      />
    </section>
  );
}

/** A TV with an arrow pointing away: the Stage went to another screen. */
function MovedTv() {
  return (
    <svg
      viewBox="0 0 120 90"
      className="h-[220px] w-[300px] animate-pop-in"
      aria-hidden="true"
      data-testid="stage-moved-tv"
    >
      <rect
        x="6"
        y="6"
        width="108"
        height="66"
        rx="16"
        className="fill-surface stroke-ink"
        strokeWidth="6"
      />
      <path
        d="M40 84h40"
        className="stroke-ink"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M48 39h24M62 29l10 10-10 10"
        className="fill-none stroke-red"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
