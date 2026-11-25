// The Stage browser's Local mics while it is the Stage: one capture, the
// kept Local mics, the rule of which devices are open (`devicesToOpen`) and
// how kept Local mics meet the channels seen (`matchLocalMics`): a missing
// Local mic found again by exact label + channel is re-keyed at once.
// `StageScreen` wraps the Stage frame in `<LocalMicsProvider>`; the Mics
// screen reads it with `useLocalMics()` and says while it is open.

import { useQuery, useQueryClient } from "@tanstack/react-query";
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

import { localMicsQuery } from "../api/queries";
import type { LocalMic } from "../generated/LocalMic";
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
  matchLocalMics,
  stageBrowserId,
  type BrowserChannel,
  type LocalMicMatch,
} from "./localMics";

export interface LocalMicsApi {
  /** `null` while this browser is not the Stage. */
  capture: LocalMicCapture | null;
  snapshot: CaptureSnapshot;
  stageBrowser: string;
  kept: readonly LocalMic[];
  /** The Mics screen says it opened (`true`) or closed. */
  setMicsScreenOpen: (open: boolean) => void;
  /** Switches a channel on or off; saved at once. */
  setSwitchedOn: (channel: BrowserChannel, on: boolean) => void;
  /** Kept Local mics against the channels seen: not found, new channels. */
  match: LocalMicMatch;
  /** Names a channel (empty: its default); saved at once. */
  rename: (channel: BrowserChannel, name: string) => void;
  /** Find it: `channel` takes over Local mic `localMicId`; saved at once. */
  relink: (localMicId: string, channel: BrowserChannel) => void;
}

const IDLE: CaptureSnapshot = {
  status: "unavailable",
  devices: [],
  open: new Map(),
};

const NO_MATCH: LocalMicMatch = { rekeys: [], notFound: [], newChannels: [] };

const noCapture: LocalMicsApi = {
  capture: null,
  snapshot: IDLE,
  stageBrowser: "",
  kept: [],
  setMicsScreenOpen: () => {},
  setSwitchedOn: () => {},
  match: NO_MATCH,
  rename: () => {},
  relink: () => {},
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

  // List the devices; ask for the microphone only if something needs it:
  // the Mics screen is open, or a channel of this browser is switched on.
  const needsMicrophone =
    micsScreenOpen ||
    kept.some((m) => m.switchedOn && m.source.stageBrowser === stageBrowser);
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

  // Every write is sent and shown at once; the change notice refetches.
  const updateKept = useCallback(
    (update: (old: readonly LocalMic[]) => LocalMic[]) => {
      queryClient.setQueryData(localMicsQuery.queryKey, (old = []) =>
        update(old),
      );
    },
    [queryClient],
  );

  const setSwitchedOn = useCallback(
    (channel: BrowserChannel, on: boolean) => {
      store.send({
        type: "setLocalMicSwitchedOn",
        localMicId: channel.localMicId,
        source: channel.source,
        switchedOn: on,
      });
      updateKept((old) => upsert(old, channel, { switchedOn: on }));
    },
    [store, updateKept],
  );

  const rename = useCallback(
    (channel: BrowserChannel, name: string) => {
      const trimmed = name.trim();
      store.send({
        type: "setLocalMicName",
        localMicId: channel.localMicId,
        source: channel.source,
        name: trimmed,
      });
      updateKept((old) => upsert(old, channel, { name: trimmed }));
    },
    [store, updateKept],
  );

  const relink = useCallback(
    (localMicId: string, channel: BrowserChannel) => {
      store.send({
        type: "relinkLocalMic",
        localMicId,
        newLocalMicId: channel.localMicId,
        source: channel.source,
      });
      updateKept((old) =>
        old.map((m) =>
          m.localMicId === localMicId
            ? { ...m, localMicId: channel.localMicId, source: channel.source }
            : m,
        ),
      );
    },
    [store, updateKept],
  );

  const match = useMemo(
    () =>
      isStage
        ? matchLocalMics({
            stageBrowser,
            devices: snapshot.devices,
            open: snapshot.open,
            kept,
          })
        : NO_MATCH,
    [isStage, stageBrowser, snapshot.devices, snapshot.open, kept],
  );

  // A missing Local mic found again by exact label + channel is re-keyed,
  // once per (old id, new id).
  const rekeyed = useRef(new Set<string>());
  useEffect(() => {
    if (!keptQuery.isSuccess) return;
    for (const { localMic, channel } of match.rekeys) {
      const key = `${localMic.localMicId}\n${channel.localMicId}`;
      if (rekeyed.current.has(key)) continue;
      rekeyed.current.add(key);
      relink(localMic.localMicId, channel);
    }
  }, [match.rekeys, keptQuery.isSuccess, relink]);

  const api = useMemo<LocalMicsApi>(
    () => ({
      capture,
      snapshot,
      stageBrowser,
      kept,
      setMicsScreenOpen,
      setSwitchedOn,
      match,
      rename,
      relink,
    }),
    [
      capture,
      snapshot,
      stageBrowser,
      kept,
      setSwitchedOn,
      match,
      rename,
      relink,
    ],
  );
  return <LocalMicsContext value={api}>{children}</LocalMicsContext>;
}

/**
 * `old` with `channel`'s Local mic changed by `change` and its source as
 * seen; a new one is added unnamed and switched off, as the server keeps it.
 */
function upsert(
  old: readonly LocalMic[],
  channel: BrowserChannel,
  change: Partial<Pick<LocalMic, "name" | "switchedOn">>,
): LocalMic[] {
  const known = old.some((m) => m.localMicId === channel.localMicId);
  return known
    ? old.map((m) =>
        m.localMicId === channel.localMicId
          ? { ...m, ...change, source: channel.source }
          : m,
      )
    : [
        ...old,
        {
          localMicId: channel.localMicId,
          source: channel.source,
          name: "",
          switchedOn: false,
          ...change,
        },
      ];
}
