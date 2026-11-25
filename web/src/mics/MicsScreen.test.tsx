import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { StageFrame } from "../stage/frame/StageFrame";
import type { CaptureSnapshot } from "./localMicCapture";
import { LocalMicsContext, type LocalMicsApi } from "./LocalMics";
import { browserChannels, type BrowserChannel } from "./localMics";

const DONGLE = { deviceId: "dongle", label: "USB Audio" };
const WEBCAM = { deviceId: "webcam", label: "Webcam Mic" };
const [dongleLeft, dongleRight] = browserChannels("stage", DONGLE, 2) as [
  BrowserChannel,
  BrowserChannel,
];

function setup({
  open = new Map([
    ["webcam", 1],
    ["dongle", 2],
  ]),
  kept = [] as LocalMic[],
}: { open?: Map<string, number>; kept?: LocalMic[] } = {}) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const snapshot: CaptureSnapshot = {
    status: "ready",
    devices: [WEBCAM, DONGLE],
    open,
  };
  const api: LocalMicsApi = {
    capture: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      refresh: () => Promise.resolve(),
      setOpen: () => Promise.resolve(),
      levelDbfs: () => -30,
      dispose: () => {},
    },
    snapshot,
    stageBrowser: "stage",
    kept,
    setMicsScreenOpen: vi.fn(),
    setSwitchedOn: vi.fn(),
  };
  render(
    <LocalMicsContext value={api}>
      <StageFrame store={store} />
    </LocalMicsContext>,
  );
  act(() => {
    handlers?.onConnection("open");
    handlers?.onMessage({
      type: "liveState",
      stageId: "main",
      isStage: true,
      party: {
        partyId: "p",
        stageId: "main",
        joinCode: "4821",
        startedAtMs: 1,
        members: [],
        phones: [],
        queue: [],
        head: null,
        lineUp: null,
      },
    });
  });
  return api;
}

function openMicsScreen() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
  });
  act(() => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Mics" }));
  });
  return screen.getByRole("dialog", { name: "Mics" });
}

describe("the Mics screen", () => {
  it("lists the This browser group's channels, devices by name and channels by number, with default names", () => {
    setup();
    const group = within(openMicsScreen()).getByRole("group", {
      name: "This browser",
    });
    expect(
      within(group)
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-label")),
    ).toEqual([
      "USB Audio · Left switched on",
      "USB Audio · Right switched on",
      "Webcam Mic switched on",
    ]);
    expect(within(group).getAllByRole("meter")).toHaveLength(3);
  });

  it("always shows the Mic bridge hint", () => {
    setup({ open: new Map() });
    expect(
      within(openMicsScreen()).getByText(
        "More than 2 inputs? Use a Mic bridge.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a new channel switched off and a kept one as kept, with its stored name", () => {
    setup({
      kept: [
        {
          localMicId: dongleRight.localMicId,
          source: dongleRight.source,
          name: "Red mic",
          switchedOn: true,
        },
      ],
    });
    const dialog = openMicsScreen();
    expect(
      within(dialog).getByRole("switch", {
        name: "USB Audio · Left switched on",
      }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      within(dialog).getByRole("switch", { name: "Red mic switched on" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("switches a channel on with no Admin PIN", () => {
    const api = setup();
    const dialog = openMicsScreen();
    const left = within(dialog).getByRole("switch", {
      name: "USB Audio · Left switched on",
    });
    act(() => {
      fireEvent.click(left);
    });
    expect(api.setSwitchedOn).toHaveBeenCalledWith(dongleLeft, true);
  });

  it("says while it is open, so every device opens for its meters", () => {
    const api = setup();
    openMicsScreen();
    expect(api.setMicsScreenOpen).toHaveBeenLastCalledWith(true);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(api.setMicsScreenOpen).toHaveBeenLastCalledWith(false);
  });
});
