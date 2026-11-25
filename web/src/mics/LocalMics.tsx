// The Stage browser's Local mics while it is the Stage: one capture, the
// kept Local mics, and the rule of which devices are open (`devicesToOpen`).
// `StageScreen` wraps the Stage frame in `<LocalMicsProvider>`; the Mics
// screen reads it with `useLocalMics()` and says while it is open.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { localMicsQuery, micBridgesQuery } from "../api/queries";
import type { ClientMessage } from "../generated/ClientMessage";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import {
  createLocalMicCapture,
  type CaptureSnapshot,
  type LocalMicCapture,
} from "./localMicCapture";
import {
  devicesToOpen,
  stageBrowserId,
  type LocalMicChannel,
} from "./localMics";

export interface LocalMicsApi {
  /** `null` while this browser is not the Stage. */
  capture: LocalMicCapture | null;
  snapshot: CaptureSnapshot;
  stageBrowser: string;
  kept: readonly LocalMic[];
  /** The Mics screen says it opened (`true`) or closed. */
  setMicsScreenOpen: (open: boolean) => void;
  /** Switches a channel (of this browser or a bridge) on or off; saved at once. */
  setSwitchedOn: (channel: LocalMicChannel, on: boolean) => void;
  /** Approved Mic bridges, in order of approval, and those waiting. */
  bridges: MicBridges;
  /** Approves a waiting Mic bridge (no Admin PIN: this is the Stage). */
  approveBridge: (requestId: number) => void;
}

const NO_BRIDGES: MicBridges = { bridges: [], requests: [] };

const IDLE: CaptureSnapshot = {
  status: "unavailable",
  devices: [],
  open: new Map(),
};

const noCapture: LocalMicsApi = {
  capture: null,
  snapshot: IDLE,
  stageBrowser: "",
  kept: [],
  setMicsScreenOpen: () => {},
  setSwitchedOn: () => {},
  bridges: NO_BRIDGES,
  approveBridge: () => {},
};

export const LocalMicsContext = createContext<LocalMicsApi>(noCapture);

export function useLocalMics(): LocalMicsApi {
  return useContext(LocalMicsContext);
}

const selectIsStage = (live: LiveState) => live.stage?.isStage ?? false;
const NO_SUBSCRIPTION = () => () => {};
const idleSnapshot = () => IDLE;

function browserStorage(): Pick<Storage, "getItem" | "setItem"> {
  return window.localStorage;
}

export function LocalMicsProvider({
  store,
  children,
  makeCapture = createLocalMicCapture,
  storage = browserStorage,
}: {
  store: LiveStore;
  children: ReactNode;
  /** Tests only: a capture over fake browser APIs. */
  makeCapture?: () => LocalMicCapture;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
}) {
  const isStage = useLive(selectIsStage, store);
  const [stageBrowser] = useState(() => stageBrowserId(storage()));
  // Made once; it touches no device until the effects below tell it to.
  const [made] = useState(makeCapture);
  const capture = isStage ? made : null;
  const [micsScreenOpen, setMicsScreenOpen] = useState(false);
  const queryClient = useQueryClient();

  // Every device closes when this browser stops being the Stage.
  useEffect(() => {
    if (!isStage) void made.setOpen(new Set());
  }, [isStage, made]);
  useEffect(
    () => () => {
      made.dispose();
    },
    [made],
  );

  const snapshot = useSyncExternalStore(
    isStage ? made.subscribe : NO_SUBSCRIPTION,
    isStage ? made.getSnapshot : idleSnapshot,
  );
  const keptQuery = useQuery({ ...localMicsQuery, enabled: isStage });
  const kept = useMemo(() => keptQuery.data ?? [], [keptQuery.data]);
  const bridgesQuery = useQuery({ ...micBridgesQuery, enabled: isStage });
  const bridges = bridgesQuery.data ?? NO_BRIDGES;

  // List the devices; ask for the microphone only if something needs it:
  // the Mics screen is open, or a channel of this browser is switched on.
  const needsMicrophone =
    micsScreenOpen ||
    kept.some(
      ({ switchedOn, source }) =>
        switchedOn &&
        source.kind === "browser" &&
        source.stageBrowser === stageBrowser,
    );
  useEffect(() => {
    if (!capture || !keptQuery.isSuccess) return;
    void capture.refresh(needsMicrophone);
  }, [capture, keptQuery.isSuccess, needsMicrophone]);

  const toOpen = useMemo(
    () =>
      [
        ...devicesToOpen({
          stageBrowser,
          devices: snapshot.devices,
          kept,
          micsScreenOpen,
        }),
      ]
        .sort()
        .join("\n"),
    [stageBrowser, snapshot.devices, kept, micsScreenOpen],
  );
  useEffect(() => {
    if (!capture) return;
    void capture.setOpen(new Set(toOpen === "" ? [] : toOpen.split("\n")));
  }, [capture, toOpen]);

  const setSwitchedOn = useCallback(
    (channel: LocalMicChannel, on: boolean) => {
      const message: ClientMessage = {
        type: "setLocalMicSwitchedOn",
        localMicId: channel.localMicId,
        source: channel.source,
        switchedOn: on,
      };
      store.send(message);
      // Shown at once; the change notice refetches the kept list.
      queryClient.setQueryData(localMicsQuery.queryKey, (old = []) => {
        const known = old.find((m) => m.localMicId === channel.localMicId);
        return known
          ? old.map((m) =>
              m === known
                ? { ...m, source: channel.source, switchedOn: on }
                : m,
            )
          : [
              ...old,
              {
                localMicId: channel.localMicId,
                source: channel.source,
                name: "",
                switchedOn: on,
              },
            ];
      });
    },
    [store, queryClient],
  );

  const approveBridge = useCallback(
    (requestId: number) => {
      store.send({ type: "approveBridge", requestId });
    },
    [store],
  );

  const api = useMemo<LocalMicsApi>(
    () => ({
      capture,
      snapshot,
      stageBrowser,
      kept,
      setMicsScreenOpen,
      setSwitchedOn,
      bridges,
      approveBridge,
    }),
    [
      capture,
      snapshot,
      stageBrowser,
      kept,
      setSwitchedOn,
      bridges,
      approveBridge,
    ],
  );
  return <LocalMicsContext value={api}>{children}</LocalMicsContext>;
}
