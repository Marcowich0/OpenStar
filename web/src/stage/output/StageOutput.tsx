// The Stage output while this browser is the Stage: `StageScreen` wraps the
// Stage in `<StageOutputProvider>`, which asks for the microphone (so the
// output label is readable), watches the default output's label and reports
// the output key to the server, which then sends that output's stored
// OpenStar volume. `useStageOutput()` gives the current key, for the values
// kept per Stage output (Mic settings #52, the A/V offset #161), and the
// output-changed event (#52's "Sound output changed" toast).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { stageBrowserId } from "../../mics/localMics";
import {
  createStageOutputWatcher,
  NO_DEVICES,
  type StageOutputWatcher,
} from "./stageOutput";

export type OutputChangedListener = (key: string, previous: string) => void;

export interface StageOutputApi {
  /** This Stage browser's id, or `null` while this is not the Stage. */
  stageBrowser: string | null;
  /** The output key, or `null` while it is unknown or this is not the Stage. */
  outputKey: string | null;
  /** Subscribes to the output-changed event (once per label change). */
  onOutputChanged: (listener: OutputChangedListener) => () => void;
}

const noOutput: StageOutputApi = {
  stageBrowser: null,
  outputKey: null,
  onOutputChanged: () => () => {},
};

const StageOutputContext = createContext<StageOutputApi>(noOutput);

export function useStageOutput(): StageOutputApi {
  return useContext(StageOutputContext);
}

const selectIsStage = (live: LiveState) => live.stage?.isStage ?? false;
const selectOpen = (live: LiveState) => live.connection === "open";

function browserWatcher(): StageOutputWatcher {
  // `mediaDevices` is missing outside a secure context.
  return createStageOutputWatcher(
    "mediaDevices" in navigator ? navigator.mediaDevices : NO_DEVICES,
  );
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> {
  return window.localStorage;
}

export function StageOutputProvider({
  store,
  children,
  makeWatcher = browserWatcher,
  storage = browserStorage,
}: {
  store: LiveStore;
  children: ReactNode;
  /** Tests only: a watcher over fake devices. */
  makeWatcher?: () => StageOutputWatcher;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
}) {
  const isStage = useLive(selectIsStage, store);
  const open = useLive(selectOpen, store);
  const [stageBrowser] = useState(() => stageBrowserId(storage()));
  // Made once; it touches no device until this browser is the Stage.
  const [watcher] = useState(makeWatcher);
  const changeListeners = useRef(new Set<OutputChangedListener>());

  // Watching while this browser is the Stage, asking for the microphone as
  // it becomes the Stage.
  useEffect(() => {
    if (!isStage) return;
    const unsubscribe = watcher.onOutputChanged((key, previous) => {
      for (const listener of changeListeners.current) listener(key, previous);
    });
    watcher.start();
    return () => {
      unsubscribe();
      watcher.stop();
    };
  }, [isStage, watcher]);

  const key = useSyncExternalStore(watcher.subscribe, watcher.current);
  const outputKey = isStage ? key : null;

  // The server keeps the output per Stage connection: tell it whenever the
  // key is read anew and after every reconnect.
  useEffect(() => {
    if (!open || outputKey === null) return;
    store.send({
      type: "reportStageOutput",
      stageBrowser,
      stageOutput: outputKey,
    });
  }, [store, open, outputKey, stageBrowser]);

  const onOutputChanged = useCallback((listener: OutputChangedListener) => {
    const listeners = changeListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const api = useMemo<StageOutputApi>(
    () => ({
      stageBrowser: isStage ? stageBrowser : null,
      outputKey,
      onOutputChanged,
    }),
    [isStage, stageBrowser, outputKey, onOutputChanged],
  );
  return <StageOutputContext value={api}>{children}</StageOutputContext>;
}
