// The 3-2-1 resume countdown over the frozen frame (#158; look #217, v1 spec
// #55 "Pause menu"): one large white digit a second with an ink outline,
// popping in with the spring easing. Each number is a new element, so its
// pop-in runs again. The pause itself shows the pause menu
// (`scenes/sing/PauseMenu.tsx`), not this.

import type { SongControlsState } from "./songControls";

/** The digit's outline: ink, drawn under the white fill. */
const OUTLINE = {
  WebkitTextStroke: "24px var(--color-ink)",
  paintOrder: "stroke fill",
} as const;

export function ResumeCountdown({ state }: { state: SongControlsState }) {
  if (state.phase !== "countdown") return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span
        key={state.count}
        data-testid="resume-countdown"
        data-count={state.count}
        className="animate-pop-in text-[40vh] leading-none font-bold text-white tabular-nums"
        style={OUTLINE}
      >
        {state.count}
      </span>
    </div>
  );
}
