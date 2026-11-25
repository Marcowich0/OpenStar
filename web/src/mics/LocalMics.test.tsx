import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import { localMicsQuery, micBridgesQuery } from "../api/queries";
import type { ClientMessage } from "../generated/ClientMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import type { CaptureSnapshot, LocalMicCapture } from "./localMicCapture";
import {
  LocalMicsProvider,
  useLocalMics,
  type LocalMicsApi,
} from "./LocalMics";
import { browserChannels, type BrowserChannel } from "./localMics";

const DONGLE = { deviceId: "dongle", label: "USB Audio" };
const WEBCAM = { deviceId: "webcam", label: "Webcam Mic" };
const [, dongleRight] = browserChannels("stage", DONGLE, 2) as [
  BrowserChannel,
  BrowserChannel,
];

function fakeCapture() {
  const snapshot: CaptureSnapshot = {
    status: "ready",
    devices: [DONGLE, WEBCAM],
    open: new Map(),
  };
  const capture: LocalMicCapture = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: vi.fn(() => Promise.resolve()),
    setOpen: vi.fn(() => Promise.resolve()),
    levelDbfs: () => null,
    dispose: vi.fn(),
  };
  return capture;
}

function setup() {
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
  queryClient.setQueryData(localMicsQuery.queryKey, [
    {
      localMicId: dongleRight.localMicId,
      source: dongleRight.source,
      name: "",
      switchedOn: true,
    },
  ]);
  queryClient.setQueryData(micBridgesQuery.queryKey, {
    bridges: [],
    requests: [{ requestId: 7, hostName: "hermes", code: "4821" }],
  });
  const capture = fakeCapture();
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
        storage={() => ({ getItem: () => "stage", setItem: () => {} })}
      >
        <Probe />
      </LocalMicsProvider>
    </QueryClientProvider>,
  );
  const becomeStage = (isStage: boolean) => {
    act(() => {
      handlers?.onConnection("open");
      handlers?.onMessage({
        type: "liveState",
        stageId: "main",
        isStage,
        party: null,
      });
    });
  };
  return {
    capture,
    makeCapture,
    sent,
    becomeStage,
    api: () => api as unknown as LocalMicsApi,
  };
}

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
});
