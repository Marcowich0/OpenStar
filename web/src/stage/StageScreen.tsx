import { useSearch } from "@tanstack/react-router";

import { stageTrust } from "../live/browserLive";
import { liveStore } from "../live/useLive";
import { LocalMicsProvider } from "../mics/LocalMics";
import { StageMicSettingsLoader } from "../mics/StageMicSettings";
import { StageOptionsLoader } from "../stageOptions/useStageOptions";
import { StageFrame } from "./frame/StageFrame";
import { useStageInput } from "./input/useStageInput";
import { StageMicReports } from "./micDebug/StageMicReports";
import { StageOutputProvider } from "./output/StageOutput";
import { StagePerfProvider } from "./perf/stagePerf";
import { useStageSong } from "./scenes/sing/useStageSong";
import { StageSoundsProvider } from "./sound/StageSounds";
import { StageTrustGate } from "./trust/StageTrustGate";

/**
 * `/stage`: the Stage, one full-screen scene at a time, with the Stage
 * browser's own Local mics captured, its Stage output watched and that
 * output's Mic settings and the Stage options loaded while it is the Stage. A browser that is not a remembered Stage browser is asked
 * for the Admin PIN first. `?perf` (and `?perf&lanes=8`) is the sing screen's
 * performance check (#227). A gamepad drives it as the keyboard does
 * (`input/gamepad.ts`). The frame plays the UI sounds
 * (`sound/StageSounds.tsx`).
 */
export function StageScreen() {
  const store = liveStore();
  // Made now, so it hears the Start that switches to the sing scene.
  useStageSong(store);
  // Gamepads, and the last input device for the key hints (#275).
  useStageInput();
  const { perf, lanes } = useSearch({ from: "/stage" });
  return (
    <StagePerfProvider perf={perf === true} lanes={lanes ?? null}>
      <StageTrustGate trust={stageTrust()}>
        <StageOutputProvider store={store}>
          <StageMicSettingsLoader
            onUncalibratedOutput={() => {
              store.showStageToast({ code: "soundOutputChanged" });
            }}
          />
          <StageMicReports store={store} />
          <StageOptionsLoader />
          <LocalMicsProvider store={store}>
            <StageSoundsProvider store={store}>
              <StageFrame store={store} />
            </StageSoundsProvider>
          </LocalMicsProvider>
        </StageOutputProvider>
      </StageTrustGate>
    </StagePerfProvider>
  );
}
