import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { StageFrame } from "../stage/frame/StageFrame";
import type { CaptureSnapshot } from "./localMicCapture";
import { LocalMicsContext, type LocalMicsApi } from "./LocalMics";
import { browserChannels, type BrowserChannel } from "./localMics";

const NO_BRIDGES: MicBridges = { bridges: [], requests: [] };

function wavChannel(bridgeId: string, channel: number) {
  return {
    localMicId: `bridge:${bridgeId}:mics.wav:${String(channel)}`,
    source: {
      kind: "bridge" as const,
      bridgeId,
      deviceName: "mics.wav",
      label: "mics.wav",
      channel,
    },
  };
}

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
  bridges = NO_BRIDGES,
}: {
  open?: Map<string, number>;
  kept?: LocalMic[];
  bridges?: MicBridges;
} = {}) {
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
    bridges,
    approveBridge: vi.fn(),
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
        playing: null,
        results: null,
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

  it("gives each approved bridge its own group after This browser, in order of approval, open or closed", () => {
    setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [wavChannel("zeus", 1), wavChannel("zeus", 0)],
          },
          { bridgeId: "apollo", hostName: "apollo", open: false, channels: [] },
        ],
        requests: [],
      },
      kept: [{ ...wavChannel("apollo", 2), name: "Red mic", switchedOn: true }],
    });
    const dialog = openMicsScreen();
    const groups = within(dialog).getAllByRole("group");
    const names = groups.map((g) => within(g).getByRole("heading").textContent);
    expect(names).toEqual([
      "This browser",
      "zeus mic bridge",
      "apollo mic bridge",
    ]);

    const zeus = groups[1] as HTMLElement;
    expect(within(zeus).getByText("Open")).toBeInTheDocument();
    expect(
      within(zeus)
        .getAllByRole("switch")
        .map((sw) => [
          sw.getAttribute("aria-label"),
          sw.getAttribute("aria-checked"),
        ]),
    ).toEqual([
      ["mics.wav · Input 1 switched on", "false"],
      ["mics.wav · Input 2 switched on", "false"],
    ]);

    const apollo = groups[2] as HTMLElement;
    expect(within(apollo).getByText("Closed")).toBeInTheDocument();
    expect(
      within(apollo).getByRole("switch", { name: "Red mic switched on" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("switches a bridge channel on like a browser one", () => {
    const channel = wavChannel("zeus", 0);
    const api = setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [channel],
          },
        ],
        requests: [],
      },
    });
    const dialog = openMicsScreen();
    act(() => {
      fireEvent.click(
        within(dialog).getByRole("switch", {
          name: "mics.wav · Input 1 switched on",
        }),
      );
    });
    expect(api.setSwitchedOn).toHaveBeenCalledWith(channel, true);
  });

  it("lists bridges waiting for approval under New bridges, approved with no Admin PIN", () => {
    const api = setup({
      bridges: {
        bridges: [],
        requests: [{ requestId: 7, hostName: "hermes", code: "4821" }],
      },
    });
    const group = within(openMicsScreen()).getByRole("group", {
      name: "New bridges",
    });
    expect(
      within(group).getByText("New mic bridge hermes · code 4821"),
    ).toBeInTheDocument();
    act(() => {
      fireEvent.click(
        within(group).getByRole("button", {
          name: "Approve mic bridge hermes, code 4821",
        }),
      );
    });
    expect(api.approveBridge).toHaveBeenCalledWith(7);
  });

  it("shows no New bridges group while no bridge waits", () => {
    setup();
    expect(
      within(openMicsScreen()).queryByRole("group", { name: "New bridges" }),
    ).toBeNull();
  });
});
