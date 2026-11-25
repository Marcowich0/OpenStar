import { liveStore } from "../live/useLive";
import { LocalMicsProvider } from "../mics/LocalMics";
import { StageFrame } from "./frame/StageFrame";
import { StageOutputProvider } from "./output/StageOutput";
import { useStageSong } from "./scenes/sing/useStageSong";

/**
 * `/stage`: the Stage, one full-screen scene at a time, with the Stage
 * browser's own Local mics captured and its Stage output watched while it
 * is the Stage.
 */
export function StageScreen() {
  const store = liveStore();
  // Made now, so it hears the Start that switches to the sing scene.
  useStageSong(store);
  return (
    <StageOutputProvider store={store}>
      <LocalMicsProvider store={store}>
        <StageFrame store={store} />
      </LocalMicsProvider>
    </StageOutputProvider>
  );
}
