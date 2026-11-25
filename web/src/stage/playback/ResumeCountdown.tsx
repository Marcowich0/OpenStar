// The plain stand-in for the sing screen's pause and resume countdown look
// (#55 draws the big popping digits): "Paused" while the Song is paused, then
// 3, 2, 1 over the frozen frame (#158).

import { t } from "../../i18n/t";
import type { SongControlsState } from "./songControls";

export function ResumeCountdown({ state }: { state: SongControlsState }) {
  if (state.phase === "playing") return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      {state.phase === "paused" ? (
        <span className="rounded-card bg-white/90 px-16 py-8 text-8xl text-ink">
          {t("stage.playback.paused")}
        </span>
      ) : (
        <span
          data-testid="resume-countdown"
          data-count={state.count}
          className="text-[320px] leading-none font-bold text-white tabular-nums"
        >
          {state.count}
        </span>
      )}
    </div>
  );
}
