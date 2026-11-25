import { liveStore } from "../live/useLive";
import { LocalMicsProvider } from "../mics/LocalMics";
import { StageFrame } from "./frame/StageFrame";
import { StageOutputProvider } from "./output/StageOutput";

/**
 * `/stage`: the Stage, one full-screen scene at a time, with the Stage
 * browser's own Local mics captured and its Stage output watched while it
 * is the Stage.
 */
export function StageScreen() {
  const store = liveStore();
  return (
    <StageOutputProvider store={store}>
      <LocalMicsProvider store={store}>
        <StageFrame store={store} />
      </LocalMicsProvider>
    </StageOutputProvider>
  );
}
