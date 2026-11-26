// `?perf` and `?perf&lanes=8` on the Stage (#227). The Stage route hands its
// search to `StagePerfProvider`; the sing scene asks `useStagePerf` what to
// draw. Without `?perf` nothing is loaded and nothing runs; with it, the
// tools (`perfTools.ts`: the overlay, the synthetic lanes and their recorded
// readings) arrive in a chunk of their own.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import type { SongClock } from "../../clock/songClock";
import type { SingState } from "../sing/frame";
import type { SyntheticLanes } from "./syntheticLanes";

/** What `perfTools.ts` offers; a seam for tests. */
export interface PerfTools {
  FrameTimeOverlay: ComponentType;
  syntheticLanes: (
    base: SingState,
    clock: Pick<SongClock, "songTimeAt" | "playingAt" | "lastSeekAt">,
    count: number,
  ) => SyntheticLanes;
}

interface StagePerfSettings {
  perf: boolean;
  /** Synthetic lanes to draw instead of the Line-up's; `null`: the real lanes. */
  lanes: number | null;
}

const StagePerfContext = createContext<StagePerfSettings>({
  perf: false,
  lanes: null,
});

export function StagePerfProvider({
  perf,
  lanes,
  children,
}: StagePerfSettings & { children: ReactNode }) {
  const value = useMemo(() => ({ perf, lanes }), [perf, lanes]);
  return (
    <StagePerfContext.Provider value={value}>
      {children}
    </StagePerfContext.Provider>
  );
}

let loading: Promise<PerfTools> | null = null;

/** Loads the tools' chunk once. */
export function loadPerfTools(): Promise<PerfTools> {
  loading ??= import("./perfTools");
  return loading;
}

export interface StagePerf {
  /** The synthetic lanes' state, to draw instead of the Song's; `null`: the Song's. */
  state: SingState | null;
  /** The frame-time overlay, a child of the sing screen; `null` without `?perf`. */
  overlay: ReactNode;
}

const OFF: StagePerf = { state: null, overlay: null };

export interface PerfFrames {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/** What the sing screen draws for the playing Song under `?perf`. */
export function useStagePerf(
  song: { state: SingState; clock: SongClock },
  load: () => Promise<PerfTools> = loadPerfTools,
  frames: PerfFrames = {},
): StagePerf {
  const { perf, lanes } = useContext(StagePerfContext);
  const [tools, setTools] = useState<PerfTools | null>(null);

  useEffect(() => {
    if (!perf) return;
    let live = true;
    void load().then((loaded) => {
      if (live) setTools(loaded);
    });
    return () => {
      live = false;
    };
  }, [perf, load]);

  const { state, clock } = song;
  const synthetic = useMemo(
    () =>
      perf && tools && lanes !== null
        ? tools.syntheticLanes(state, clock, lanes)
        : null,
    [perf, tools, lanes, state, clock],
  );

  // Feed the synthetic lanes once per animation frame.
  const { requestFrame, cancelFrame } = frames;
  useEffect(() => {
    if (!synthetic) return;
    const request =
      requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    const cancel =
      cancelFrame ??
      ((handle) => {
        window.cancelAnimationFrame(handle);
      });
    let handle = 0;
    const onFrame = () => {
      synthetic.tick();
      handle = request(onFrame);
    };
    handle = request(onFrame);
    return () => {
      cancel(handle);
    };
  }, [synthetic, requestFrame, cancelFrame]);

  const Overlay = tools?.FrameTimeOverlay;
  const overlay = useMemo(
    () => (perf && Overlay ? <Overlay /> : null),
    [perf, Overlay],
  );
  if (!perf) return OFF;
  return { state: synthetic?.state ?? null, overlay };
}
