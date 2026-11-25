// The song browser: the Stage's resting scene. A placeholder with the Join
// code until the song browser ticket builds the carousel and the join card.

import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { useStageFrame } from "../frame/stageFrameContext";

const selectJoinCode = (live: LiveState) => live.stage?.party?.joinCode ?? null;

export function SongBrowserScene() {
  const { store, openOverlay } = useStageFrame();
  const joinCode = useLive(selectJoinCode, store);
  return (
    <section className="flex h-full flex-col items-center justify-center gap-12">
      <p className="text-3xl font-semibold text-ink-2">
        {t("stage.browser.joinCode")}
      </p>
      <p
        className="text-9xl font-bold tracking-widest tabular-nums"
        data-testid="party-join-code"
      >
        {joinCode}
      </p>
      <h1 className="text-8xl font-bold">{t("stage.browser.pickFromPhone")}</h1>
      <span data-stage-default>
        <Button
          fill="green"
          size="big"
          onPress={() => {
            openOverlay("songs");
          }}
        >
          {t("stage.browser.browse")}
        </Button>
      </span>
    </section>
  );
}
