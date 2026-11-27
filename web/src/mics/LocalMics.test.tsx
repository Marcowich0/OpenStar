import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import { localMicsQuery, micBridgesQuery } from "../api/queries";
import type { ClientMessage } from "../generated/ClientMessage";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import type { PartySnapshot } from "../generated/PartySnapshot";
import { createPitchRouter } from "../pitch/pitchRouter";
import { LEO_SEAT, testLineUp, testParty } from "../stage/scenes/sing/testSong";
import type {
  CaptureSnapshot,
  LocalMicCapture,
  ReadingListener,
} from "./localMicCapture";
import {
  LocalMicsProvider,
  useLocalMics,
  type LocalMicsApi,
} from "./LocalMics";
import { browserChannels, type BrowserChannel } from "./localMics";
import { stageMicSettings } from "./stageMicSettings";

const DONGLE = { deviceId: "dongle", label: "USB Audio" };
const WEBCAM = { deviceId: "webcam", label: "Webcam Mic" };
const [, dongleRight] = browserChannels("stage", DONGLE, 2) as [
  BrowserChannel,
  BrowserChannel,
];

function fakeCapture(
  devices = [DONGLE, WEBCAM],
  open: ReadonlyMap<string, number> = new Map(),
  inputDelaysMs: ReadonlyMap<string, number> = new Map(),
) {
  const snapshot: CaptureSnapshot = {
    status: "ready",
    devices,
    open,
    inputDelaysMs,
  };
  const readingListeners = new Set<ReadingListener>();
  const capture = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: vi.fn(() => Promise.resolve()),
    setOpen: vi.fn(() => Promise.resolve()),
    levelDbfs: () => null,
    digitalZero: () => null,
    setDetecting: vi.fn(),
    subscribeReadings: (listener: ReadingListener) => {
      readingListeners.add(listener);
      return () => readingListeners.delete(listener);
    },
    dispose: vi.fn(),
    /** Plays the capture handing on a stamped reading. */
    read: (...args: Parameters<ReadingListener>) => {
      for (const listener of readingListeners) listener(...args);
    },
  } satisfies LocalMicCapture & Record<string, unknown>;
  return capture;
}

const keptRight: LocalMic = {
  localMicId: dongleRight.localMicId,
  source: dongleRight.source,
  name: "",
  switchedOn: true,
};

function setup({
  kept = [keptRight],
  capture = fakeCapture(),
  pitch = createPitchRouter(),
  bridges = {
    bridges: [],
    requests: [{ requestId: 7, hostName: "hermes", code: "4821" }],
  },
}: {
  kept?: LocalMic[];
  capture?: LocalMicCapture;
  pitch?: ReturnType<typeof createPitchRouter>;
  bridges?: MicBridges;
} = {}) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(localMicsQuery.queryKey, kept);
  queryClient.setQueryData(micBridgesQuery.queryKey, bridges);
  const makeCapture = vi.fn(() => capture);
  let api: LocalMicsApi | null = null;
  function Probe() {
    api = useLocalMics();
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <LocalMicsProvider
        store={store}
        makeCapture={makeCapture}
        pitch={pitch}
        storage={() => ({ getItem: () => "stage", setItem: () => {} })}
      >
        <Probe />
      </LocalMicsProvider>
    </QueryClientProvider>,
  );
  const becomeStage = (
    isStage: boolean,
    party: PartySnapshot | null = null,
  ) => {
    act(() => {
      handlers?.onConnection("open");
      handlers?.onMessage({
        type: "liveState",
        stageId: "main",
        isStage,
        party,
      });
    });
  };
  const reconnect = () => {
    act(() => {
      handlers?.onConnection("reconnecting");
    });
    becomeStage(true);
  };
  const server = (message: Parameters<LiveClientOptions["onMessage"]>[0]) => {
    act(() => {
      handlers?.onMessage(message);
    });
  };
  return {
    capture,
    makeCapture,
    sent,
    becomeStage,
    reconnect,
    server,
    api: () => api as unknown as LocalMicsApi,
  };
}

describe("the Stage browser's Local mic readings", () => {
  const seated = (playing: boolean) =>
    testParty({
      lineUp: testLineUp([
        {
          ...LEO_SEAT,
          mic: { kind: "localMic", localMicId: dongleRight.localMicId },
        },
      ]),
      playing: playing ? { requestId: 5, songId: 7, paused: false } : null,
      localMics: [
        {
          localMicId: dongleRight.localMicId,
          source: dongleRight.source,
          name: "",
          present: true,
        },
      ],
    });
  const openDongle = () => fakeCapture([DONGLE], new Map([["dongle", 2]]));
  const READING = { captureMs: 1234, pitch: 69, clarity: 0.9, loudness: -20 };

  it("run the detector of a seated Local mic only while its Song plays", () => {
    const capture = openDongle();
    const { becomeStage } = setup({ capture });
    becomeStage(true, seated(false));
    expect(capture.setDetecting).toHaveBeenLastCalledWith([]);
    becomeStage(true, seated(true));
    expect(capture.setDetecting).toHaveBeenLastCalledWith([
      { deviceId: "dongle", channel: 1 },
    ]);
    becomeStage(true, seated(false));
    expect(capture.setDetecting).toHaveBeenLastCalledWith([]);
  });

  it("run the detector of a Calibration run's Local mic, seated or not", () => {
    const capture = openDongle();
    const { becomeStage, server } = setup({ capture });
    becomeStage(true, testParty({ localMics: seated(false).localMics }));
    expect(capture.setDetecting).toHaveBeenLastCalledWith([]);
    const mics = [
      {
        mic: { kind: "localMic" as const, localMicId: dongleRight.localMicId },
        chosen: true,
        ready: true,
      },
    ];
    server({ type: "calibration", run: { phase: "waiting", mics } });
    expect(capture.setDetecting).toHaveBeenLastCalledWith([
      { deviceId: "dongle", channel: 1 },
    ]);
    server({ type: "calibration", run: { phase: "results", mics } });
    expect(capture.setDetecting).toHaveBeenLastCalledWith([]);
  });

  it("hand each reading on under its Local mic id, for a Calibration run", () => {
    const capture = openDongle();
    const { becomeStage, api } = setup({ capture });
    becomeStage(true);
    const heard: [string, number][] = [];
    const stop = api().subscribeLocalMicReadings((localMicId, reading) => {
      heard.push([localMicId, reading.captureMs]);
    });
    capture.read("dongle", 1, READING);
    stop();
    capture.read("dongle", 1, READING);
    expect(heard).toEqual([[dongleRight.localMicId, 1234]]);
  });

  it("reach the Pitch router's buffer of the Player the Local mic sings for", () => {
    const capture = openDongle();
    const pitch = createPitchRouter();
    const { becomeStage } = setup({ capture, pitch });
    becomeStage(true, seated(true));
    const [buffer] = pitch.start({
      players: 1,
      mics: [[{ kind: "localMic", localMicId: dongleRight.localMicId }, 0]],
      capacity: 8,
      place: (r) => r.captureMs / 1000,
    });
    capture.read("dongle", 1, READING);
    capture.read("dongle", 0, READING);
    expect(buffer?.size).toBe(1);
    expect(buffer?.newestPitch()).toBe(69);
  });
});

describe("the Stage browser's Local mics", () => {
  it("capture nothing while the browser is not the Stage", () => {
    const { capture, becomeStage } = setup();
    becomeStage(false);
    expect(capture.refresh).not.toHaveBeenCalled();
    expect(capture.setOpen).not.toHaveBeenCalledWith(new Set(["dongle"]));
  });

  it("open the devices with a switched-on channel when the browser becomes the Stage, asking for the microphone", () => {
    const { capture, becomeStage } = setup();
    becomeStage(true);
    expect(capture.refresh).toHaveBeenLastCalledWith(true);
    expect(capture.setOpen).toHaveBeenLastCalledWith(new Set(["dongle"]));
  });

  it("open every device while the Mics screen is open, and only the switched-on ones after", () => {
    const { capture, becomeStage, api } = setup();
    becomeStage(true);
    act(() => {
      api().setMicsScreenOpen(true);
    });
    expect(capture.setOpen).toHaveBeenLastCalledWith(
      new Set(["dongle", "webcam"]),
    );
    act(() => {
      api().setMicsScreenOpen(false);
    });
    expect(capture.setOpen).toHaveBeenLastCalledWith(new Set(["dongle"]));
  });

  it("save a switch at once and show it before the server answers", async () => {
    const { becomeStage, api, sent } = setup();
    becomeStage(true);
    const [webcam] = browserChannels("stage", WEBCAM, 1) as [BrowserChannel];
    await act(async () => {
      api().setSwitchedOn(webcam, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent).toContainEqual({
      type: "setLocalMicSwitchedOn",
      localMicId: webcam.localMicId,
      source: webcam.source,
      switchedOn: true,
    });
    expect(
      api().kept.find((m) => m.localMicId === webcam.localMicId)?.switchedOn,
    ).toBe(true);
  });

  it("close every device when the browser stops being the Stage", () => {
    const { capture, becomeStage } = setup();
    becomeStage(true);
    // Another browser took the Stage.
    becomeStage(false);
    expect(capture.setOpen).toHaveBeenLastCalledWith(new Set());
  });

  it("list the Mic bridges and approve a waiting one over the Stage's WebSocket", () => {
    const { becomeStage, api, sent } = setup();
    becomeStage(true);
    expect(api().bridges.requests).toEqual([
      { requestId: 7, hostName: "hermes", code: "4821" },
    ]);
    act(() => {
      api().approveBridge(7);
    });
    expect(sent).toContainEqual({ type: "approveBridge", requestId: 7 });
  });

  it("tell the server while the Mics screen is open, and again after a reconnect", () => {
    const { becomeStage, reconnect, api, sent } = setup();
    becomeStage(true);
    const said = () =>
      sent.flatMap((m) => (m.type === "setMicsScreenOpen" ? [m.open] : []));
    expect(said()).toEqual([false]);
    act(() => {
      api().setMicsScreenOpen(true);
    });
    expect(said()).toEqual([false, true]);
    reconnect();
    expect(said()).toEqual([false, true, true]);
    act(() => {
      api().setMicsScreenOpen(false);
    });
    expect(said()).toEqual([false, true, true, false]);
  });

  it("report which of its Local mics are plugged in, and again after a reconnect", () => {
    const { becomeStage, reconnect, sent } = setup();
    const reports = () =>
      sent.flatMap((m) =>
        m.type === "reportPresentLocalMics" ? [m.localMicIds] : [],
      );
    becomeStage(false);
    expect(reports()).toEqual([]);
    becomeStage(true);
    expect(reports()).toEqual([[dongleRight.localMicId]]);
    reconnect();
    expect(reports()).toEqual([
      [dongleRight.localMicId],
      [dongleRight.localMicId],
    ]);
  });

  it("report which of its Local mics capture: their device is open", () => {
    const capturing = (sent: ClientMessage[]) =>
      sent.flatMap((m) =>
        m.type === "reportCapturingLocalMics" ? [m.localMicIds] : [],
      );
    const closed = setup();
    closed.becomeStage(true);
    expect(capturing(closed.sent)).toEqual([[]]);
    const open = setup({
      capture: fakeCapture([DONGLE], new Map([["dongle", 2]])),
    });
    open.becomeStage(true);
    expect(capturing(open.sent)).toEqual([[dongleRight.localMicId]]);
    // A mono device has no Right channel to capture.
    const mono = setup({
      capture: fakeCapture([DONGLE], new Map([["dongle", 1]])),
    });
    mono.becomeStage(true);
    expect(capturing(mono.sent)).toEqual([[]]);
  });

  it("hold each Local mic's reported input delay, from its open device or its Mic bridge, for Start", () => {
    const bridgeMic = "bridge:zeus:card:1";
    const { becomeStage } = setup({
      capture: fakeCapture(
        [DONGLE, WEBCAM],
        new Map([
          ["dongle", 2],
          ["webcam", 1],
        ]),
        new Map([["dongle", 11]]),
      ),
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [
              {
                localMicId: bridgeMic,
                source: {
                  kind: "bridge",
                  bridgeId: "zeus",
                  deviceName: "card",
                  label: "Scarlett",
                  channel: 1,
                },
                reportedInputDelayMs: 4,
              },
              {
                localMicId: "bridge:zeus:card:0",
                source: {
                  kind: "bridge",
                  bridgeId: "zeus",
                  deviceName: "card",
                  label: "Scarlett",
                  channel: 0,
                },
              },
            ],
            interfaces: [],
          },
        ],
        requests: [],
      },
    });
    try {
      becomeStage(true);
      const holder = stageMicSettings();
      expect(holder.reportedInputDelayMs(dongleRight.localMicId)).toBe(11);
      expect(holder.reportedInputDelayMs(bridgeMic)).toBe(4);
      expect(holder.reportedInputDelayMs("bridge:zeus:card:0")).toBeNull();
      expect(holder.reportedInputDelayMs("browser:stage:webcam:0")).toBeNull();
    } finally {
      stageMicSettings().setReportedInputDelays(new Map());
    }
  });

  it("report a Local mic whose device is unplugged as not present", () => {
    const { becomeStage, sent } = setup({ capture: fakeCapture([WEBCAM]) });
    becomeStage(true);
    expect(sent).toContainEqual({
      type: "reportPresentLocalMics",
      localMicIds: [],
    });
  });

  it("say nothing about the Mics screen while the browser is not the Stage", () => {
    const { becomeStage, api, sent } = setup();
    becomeStage(false);
    act(() => {
      api().setMicsScreenOpen(true);
    });
    expect(sent.filter((m) => m.type === "setMicsScreenOpen")).toEqual([]);
  });

  it("report a bridge Local mic in exact digital silence for more than 2 s, and when it sounds again", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { becomeStage, server, sent } = setup();
      const id = "bridge:zeus:mics.wav:0";
      becomeStage(
        true,
        testParty({
          localMics: [
            {
              localMicId: id,
              name: "",
              present: true,
              source: {
                kind: "bridge",
                bridgeId: "zeus",
                deviceName: "mics.wav",
                label: "mics.wav",
                channel: 0,
              },
            },
          ],
        }),
      );
      const reports = () =>
        sent.flatMap((m) =>
          m.type === "reportSilentLocalMics" ? [m.localMicIds] : [],
        );
      const level = (digitalSilence: boolean) => {
        server({
          type: "localMicLevels",
          levels: [{ localMicId: id, levelDbfs: -100, digitalSilence }],
        });
      };
      // Ten levels a second of exact zeros: reported once past 2 s.
      for (let step = 0; step <= 25; step++) {
        level(true);
        act(() => {
          now += 100;
          vi.advanceTimersByTime(100);
        });
        if (now <= 2000) expect(reports()).toEqual([]);
      }
      expect(reports()).toEqual([[id]]);
      level(false);
      act(() => {
        now += 250;
        vi.advanceTimersByTime(250);
      });
      expect(reports()).toEqual([[id], []]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("keep the Mic bridge levels the server relays for the meters", () => {
    const { becomeStage, api, server } = setup();
    becomeStage(true);
    const id = "bridge:zeus:mics.wav:0";
    expect(api().bridgeLevelDbfs(id)).toBeNull();
    server({
      type: "localMicLevels",
      levels: [{ localMicId: id, levelDbfs: -12, digitalSilence: false }],
    });
    expect(api().bridgeLevelDbfs(id)).toBe(-12);
  });

  it("keep each Phone's loudness from its Pitch readings for the seat meters", () => {
    const { becomeStage, api, server } = setup();
    becomeStage(true);
    expect(api().phoneLevelDbfs("phone-1")).toBeNull();
    server({
      type: "pitchReading",
      mic: { kind: "phone", phoneId: "phone-1" },
      reading: { captureMs: 5, pitch: null, clarity: 0.1, loudness: -33 },
    });
    expect(api().phoneLevelDbfs("phone-1")).toBe(-33);
    expect(api().phoneLevelDbfs("phone-2")).toBeNull();
  });

  it("name a channel at once, with no Admin PIN, and show it before the server answers", async () => {
    const { becomeStage, api, sent } = setup();
    becomeStage(true);
    const [webcam] = browserChannels("stage", WEBCAM, 1) as [BrowserChannel];
    await act(async () => {
      api().rename(webcam, "Red mic");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent).toContainEqual({
      type: "setLocalMicName",
      localMicId: webcam.localMicId,
      source: webcam.source,
      name: "Red mic",
    });
    expect(api().kept.find((m) => m.localMicId === webcam.localMicId)).toEqual({
      localMicId: webcam.localMicId,
      source: webcam.source,
      name: "Red mic",
      switchedOn: false,
    });
  });

  it("re-link a Local mic with Find it, keeping its name and switch", async () => {
    const { becomeStage, api, sent } = setup({
      kept: [{ ...keptRight, name: "Red mic" }],
    });
    becomeStage(true);
    const [webcam] = browserChannels("stage", WEBCAM, 1) as [BrowserChannel];
    await act(async () => {
      api().relink(keptRight.localMicId, webcam);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent).toContainEqual({
      type: "relinkLocalMic",
      localMicId: keptRight.localMicId,
      newLocalMicId: webcam.localMicId,
      source: webcam.source,
    });
    expect(api().kept).toEqual([
      {
        localMicId: webcam.localMicId,
        source: webcam.source,
        name: "Red mic",
        switchedOn: true,
      },
    ]);
  });

  it("re-key a missing Local mic to the one channel with its exact label and channel, once", async () => {
    const reconnected = { deviceId: "dongle-new", label: "USB Audio" };
    const [, newRight] = browserChannels("stage", reconnected, 2) as [
      BrowserChannel,
      BrowserChannel,
    ];
    const { becomeStage, api, sent } = setup({
      kept: [{ ...keptRight, name: "Red mic" }],
      capture: fakeCapture([reconnected], new Map([["dongle-new", 2]])),
    });
    becomeStage(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent.filter((m) => m.type === "relinkLocalMic")).toEqual([
      {
        type: "relinkLocalMic",
        localMicId: keptRight.localMicId,
        newLocalMicId: newRight.localMicId,
        source: newRight.source,
      },
    ]);
    expect(api().kept.map((m) => [m.localMicId, m.name])).toEqual([
      [newRight.localMicId, "Red mic"],
    ]);
    expect(api().match.notFound).toEqual([]);
  });
});
