// The Stage browser's Local mics while it is the Stage: one capture, the
// kept Local mics, the rule of which devices are open (`devicesToOpen`) and
// how kept Local mics meet the channels seen (`matchLocalMics`): a missing
// Local mic found again by exact label + channel is re-keyed at once.
// `StageScreen` wraps the Stage frame in `<LocalMicsProvider>`; the Mics
// screen reads it with `useLocalMics()` and says while it is open. While a
// Song plays, the detectors of its seated Local mics run and their readings
// go into the Stage's Pitch router (`localMicPitch.ts`).

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

import { localMicsQuery, micBridgesQuery } from "../api/queries";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import { stagePitch } from "../live/browserLive";
import type { LiveState } from "../live/liveState";
import type { PitchRouter } from "../pitch/pitchRouter";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { createBridgeLevels } from "./bridgeLevels";
import { createSilentLocalMics } from "./silentLocalMics";
import {
  createLocalMicCapture,
  type CaptureSnapshot,
  type LocalMicCapture,
} from "./localMicCapture";
import {
  detectingChannels,
  detectingLocalMics,
  routeLocalMicReadings,
} from "./localMicPitch";
import {
  devicesToOpen,
  matchLocalMics,
  presentLocalMics,
  stageBrowserId,
  type LocalMicChannel,
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
  /** Switches a channel (of this browser or a bridge) on or off; saved at once. */
  setSwitchedOn: (channel: LocalMicChannel, on: boolean) => void;
  /** Approved Mic bridges, in order of approval, and those waiting. */
  bridges: MicBridges;
  /** Approves a waiting Mic bridge (no Admin PIN: this is the Stage). */
  approveBridge: (requestId: number) => void;
  /**
   * Switch to Pro Audio for interface `deviceName` of open bridge
   * `bridgeId`: the bridge tries the switch itself (no Admin PIN).
   */
  switchBridgeToProAudio: (bridgeId: string, deviceName: string) => void;
  /** Kept Local mics of this browser against the channels seen: not found, new channels. */
  match: LocalMicMatch;
  /** Names a channel (of this browser or a bridge; empty: its default); saved at once. */
  rename: (channel: LocalMicChannel, name: string) => void;
  /** Find it: `channel` takes over Local mic `localMicId`; saved at once. */
  relink: (localMicId: string, channel: LocalMicChannel) => void;
  /**
   * A Mic bridge Local mic's latest level in dBFS, as its bridge sent it
   * (`null`: none lately). Bridges send levels for switched-on channels,
   * and for all while the Mics screen is open.
   */
  bridgeLevelDbfs: (localMicId: string) => number | null;
  /**
   * A Phone's latest loudness in dBFS, from the Pitch readings it sends
   * once its mic is on (`null`: none lately). Read by the seat meters.
   */
  phoneLevelDbfs: (phoneId: string) => number | null;
}

const NO_BRIDGES: MicBridges = { bridges: [], requests: [] };

const IDLE: CaptureSnapshot = {
  status: "unavailable",
  devices: [],
  open: new Map(),
};

const NO_MATCH: LocalMicMatch = { rekeys: [], notFound: [], newChannels: [] };

/** What `useLocalMics()` gives without a provider: no capture, nothing kept. */
export const NO_LOCAL_MICS: LocalMicsApi = {
  capture: null,
  snapshot: IDLE,
  stageBrowser: "",
  kept: [],
  setMicsScreenOpen: () => {},
  setSwitchedOn: () => {},
  bridges: NO_BRIDGES,
  approveBridge: () => {},
  switchBridgeToProAudio: () => {},
  bridgeLevelDbfs: () => null,
  phoneLevelDbfs: () => null,
  match: NO_MATCH,
  rename: () => {},
  relink: () => {},
};

export const LocalMicsContext = createContext<LocalMicsApi>(NO_LOCAL_MICS);

export function useLocalMics(): LocalMicsApi {
  return useContext(LocalMicsContext);
}

const selectIsStage = (live: LiveState) => live.stage?.isStage ?? false;
const selectConnected = (live: LiveState) => live.connection === "open";
const selectParty = (live: LiveState) => live.stage?.party ?? null;
/** How often the Stage looks for Local mics in digital silence, ms. */
const SILENCE_LOOK_MS = 250;

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
  pitch = stagePitch(),
}: {
  store: LiveStore;
  children: ReactNode;
  /** Tests only: a capture over fake browser APIs. */
  makeCapture?: () => LocalMicCapture;
  /** Where this browser's Local mic readings go: the Stage's Pitch router. */
  pitch?: PitchRouter;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
}) {
  const isStage = useLive(selectIsStage, store);
  const [stageBrowser] = useState(() => stageBrowserId(storage()));
  // Made once; it touches no device until the effects below tell it to.
  const [made] = useState(makeCapture);
  const capture = isStage ? made : null;
  const [micsScreenOpen, setMicsScreenOpen] = useState(false);
  const queryClient = useQueryClient();

  // The server tells the Mic bridges whether the Mics screen is open, so
  // they open every interface and meter every channel while it is. Said
  // again on every connect: a new connection starts closed.
  const connected = useLive(selectConnected, store);
  useEffect(() => {
    if (isStage && connected)
      store.send({ type: "setMicsScreenOpen", open: micsScreenOpen });
  }, [store, isStage, connected, micsScreenOpen]);

  // The levels the bridges send, kept outside React for the meters.
  const [levels] = useState(createBridgeLevels);
  useEffect(
    () =>
      store.onLocalMicLevels((received) => {
        levels.receive(received, performance.now());
      }),
    [store, levels],
  );
  const bridgeLevelDbfs = useCallback(
    (localMicId: string) => levels.levelDbfs(localMicId, performance.now()),
    [levels],
  );

  // Each Phone's loudness, from its Pitch readings, for the seat meters.
  // Kept like the bridge levels: the latest one, forgotten when stale.
  const [phoneLevels] = useState(createBridgeLevels);
  useEffect(
    () =>
      store.onPitchReading((mic, reading) => {
        // A bridge's Local mics have their own levels.
        if (mic.kind !== "phone") return;
        phoneLevels.receive(
          [{ localMicId: mic.phoneId, levelDbfs: reading.loudness }],
          performance.now(),
        );
      }),
    [store, phoneLevels],
  );
  const phoneLevelDbfs = useCallback(
    (phoneId: string) => phoneLevels.levelDbfs(phoneId, performance.now()),
    [phoneLevels],
  );

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

  // Detectors run only for the Local mics seated in the Song that plays;
  // every open device keeps its meters either way.
  const party = useLive(selectParty, store);
  const detecting = useMemo(
    () => [...detectingLocalMics(party)].sort().join("\n"),
    [party],
  );
  useEffect(() => {
    made.setDetecting(
      capture
        ? detectingChannels({
            stageBrowser,
            open: snapshot.open,
            detecting: new Set(detecting === "" ? [] : detecting.split("\n")),
          })
        : [],
    );
  }, [made, capture, stageBrowser, snapshot.open, detecting]);
  useEffect(() => {
    if (!capture) return;
    return routeLocalMicReadings(capture, stageBrowser, pitch);
  }, [capture, stageBrowser, pitch]);

  // The server offers the switched-on Local mics that are plugged in to the
  // Line-up: tell it which of this browser's are, whenever that changes and
  // on every connect (a new connection starts with none).
  const present = useMemo(
    () =>
      presentLocalMics({
        stageBrowser,
        devices: snapshot.devices,
        open: snapshot.open,
        kept,
      }).join("\n"),
    [stageBrowser, snapshot.devices, snapshot.open, kept],
  );
  useEffect(() => {
    if (!isStage || !connected || !keptQuery.isSuccess) return;
    store.send({
      type: "reportPresentLocalMics",
      localMicIds: present === "" ? [] : present.split("\n"),
    });
  }, [store, isStage, connected, keptQuery.isSuccess, present]);

  // Exact digital silence for more than 2 s, on either path, is the "sends
  // no sound" seat warning: looked at four times a second and reported
  // whenever it changes (a new connection starts with none).
  const [silentWatch] = useState(createSilentLocalMics);
  const [silent, setSilent] = useState("");
  const partyLocalMics = party?.localMics;
  useEffect(() => {
    if (!isStage) return;
    const look = () => {
      const now = performance.now();
      const ids = silentWatch.look(
        partyLocalMics ?? [],
        {
          browser: (deviceId, channel) => made.digitalZero(deviceId, channel),
          bridge: (localMicId) => levels.digitalZero(localMicId, now),
        },
        now,
      );
      setSilent(ids.join("\n"));
    };
    look();
    const timer = setInterval(look, SILENCE_LOOK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isStage, made, levels, silentWatch, partyLocalMics]);
  const reportedSilent = useRef("");
  useEffect(() => {
    if (!isStage || !connected) {
      reportedSilent.current = "";
      return;
    }
    if (silent === reportedSilent.current) return;
    reportedSilent.current = silent;
    store.send({
      type: "reportSilentLocalMics",
      localMicIds: silent === "" ? [] : silent.split("\n"),
    });
  }, [store, isStage, connected, silent]);

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
    (channel: LocalMicChannel, on: boolean) => {
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

  const approveBridge = useCallback(
    (requestId: number) => {
      store.send({ type: "approveBridge", requestId });
    },
    [store],
  );

  const switchBridgeToProAudio = useCallback(
    (bridgeId: string, deviceName: string) => {
      store.send({ type: "switchBridgeToProAudio", bridgeId, deviceName });
    },
    [store],
  );

  const rename = useCallback(
    (channel: LocalMicChannel, name: string) => {
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
    (localMicId: string, channel: LocalMicChannel) => {
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
      bridges,
      approveBridge,
      switchBridgeToProAudio,
      match,
      rename,
      relink,
      bridgeLevelDbfs,
      phoneLevelDbfs,
    }),
    [
      capture,
      snapshot,
      stageBrowser,
      kept,
      setSwitchedOn,
      bridges,
      approveBridge,
      switchBridgeToProAudio,
      match,
      rename,
      relink,
      bridgeLevelDbfs,
      phoneLevelDbfs,
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
  channel: LocalMicChannel,
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
