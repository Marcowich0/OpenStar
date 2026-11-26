import { stageTrust } from "../live/browserLive";
import { liveStore } from "../live/useLive";
import { LocalMicsProvider } from "../mics/LocalMics";
import { StageMicSettingsLoader } from "../mics/StageMicSettings";
import { StageFrame } from "./frame/StageFrame";
import { StageOutputProvider } from "./output/StageOutput";
import { useStageSong } from "./scenes/sing/useStageSong";
import { StageTrustGate } from "./trust/StageTrustGate";

/**
 * `/stage`: the Stage, one full-screen scene at a time, with the Stage
 * browser's own Local mics captured, its Stage output watched and that
 * output's Mic settings loaded while it is the Stage. A browser that is not a remembered Stage browser is asked
 * for the Admin PIN first.
 */
export function StageScreen() {
  const store = liveStore();
  // Made now, so it hears the Start that switches to the sing scene.
  useStageSong(store);
  return (
    <StageTrustGate trust={stageTrust()}>
      <StageOutputProvider store={store}>
        <StageMicSettingsLoader />
        <LocalMicsProvider store={store}>
          <StageFrame store={store} />
        </LocalMicsProvider>
      </StageOutputProvider>
    </StageTrustGate>
  );
}
