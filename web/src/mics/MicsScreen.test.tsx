import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";

import { createQueryClient } from "../api/queryClient";
import type { LocalMic } from "../generated/LocalMic";
import type { MicBridges } from "../generated/MicBridges";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { SCENES } from "../stage/frame/sceneComponents";
import { StageFrame } from "../stage/frame/StageFrame";
import type { CaptureSnapshot } from "./localMicCapture";
import { stageMicSettings } from "./stageMicSettings";
import { LocalMicsContext, type LocalMicsApi } from "./LocalMics";
import {
  browserChannels,
  matchLocalMics,
  type BrowserChannel,
} from "./localMics";

// The song browser needs the Library's Songs; this test is not about it.
const NO_BROWSER = { ...SCENES, songBrowser: { component: () => null } };

const NO_BRIDGES: MicBridges = { bridges: [], requests: [] };

// The Stage applies the OpenStar volume to its audio chain; jsdom has none.
vi.mock("../stage/playback/stageAudio", () => ({
  stageAudio: () => ({ chain: () => ({ setVolume: () => {} }) }),
}));

/** What the last `setup` sent to the server. */
let sent: ClientMessage[] = [];
let toStage: Pick<LiveClientOptions, "onMessage"> | null = null;
/** Shows the last `setup` again with the Mic bridges `next`. */
let withBridges: (next: MicBridges) => void = () => {};

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
const [webcam] = browserChannels("stage", WEBCAM, 1) as [BrowserChannel];
// A kept Local mic whose device is no longer listed under its id.
const [, goneRight] = browserChannels(
  "stage",
  { deviceId: "gone", label: "Zoom H1" },
  2,
) as [BrowserChannel, BrowserChannel];

function setup({
  open = new Map([
    ["webcam", 1],
    ["dongle", 2],
  ]),
  kept = [] as LocalMic[],
  bridges = NO_BRIDGES,
  bridgeLevelDbfs = () => null,
}: {
  open?: Map<string, number>;
  kept?: LocalMic[];
  bridges?: MicBridges;
  bridgeLevelDbfs?: (localMicId: string) => number | null;
} = {}) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  sent = [];
  const store = createLiveStore((given) => {
    handlers = given;
    toStage = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
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
      digitalZero: () => null,
      setDetecting: () => {},
      subscribeReadings: () => () => {},
      dispose: () => {},
    },
    snapshot,
    stageBrowser: "stage",
    kept,
    setMicsScreenOpen: vi.fn(),
    setSwitchedOn: vi.fn(),
    bridges,
    approveBridge: vi.fn(),
    switchBridgeToProAudio: vi.fn(),
    match: matchLocalMics({
      stageBrowser: "stage",
      devices: snapshot.devices,
      open,
      kept,
    }),
    rename: vi.fn(),
    relink: vi.fn(),
    bridgeLevelDbfs,
    phoneLevelDbfs: () => null,
    subscribeLocalMicReadings: () => () => {},
  };
  const client = createQueryClient();
  const view = (value: LocalMicsApi) => (
    <QueryClientProvider client={client}>
      <LocalMicsContext value={value}>
        <StageFrame store={store} scenes={NO_BROWSER} />
      </LocalMicsContext>
    </QueryClientProvider>
  );
  const rendered = render(view(api));
  withBridges = (next) => {
    rendered.rerender(view({ ...api, bridges: next }));
  };
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
        localMics: [],
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

  it("offers Add a Mic bridge after the groups", () => {
    setup();
    expect(
      within(openMicsScreen()).getByRole("button", {
        name: "Add a Mic bridge",
      }),
    ).toHaveAttribute("aria-expanded", "false");
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
            interfaces: [],
          },
          {
            bridgeId: "apollo",
            hostName: "apollo",
            open: false,
            channels: [],
            interfaces: [],
          },
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
    // A closed bridge's Local mic is closed, not "not found" in This browser.
    expect(within(dialog).queryByText("Red mic · not found")).toBeNull();
  });

  it("offers Forget on each approved bridge's group, open or closed, and nowhere else", () => {
    setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [],
            interfaces: [],
          },
          {
            bridgeId: "apollo",
            hostName: "apollo",
            open: false,
            channels: [],
            interfaces: [],
          },
        ],
        requests: [{ requestId: 7, hostName: "hermes", code: "4821" }],
      },
    });
    const dialog = openMicsScreen();
    const groups = within(dialog).getAllByRole("group");
    const forgets = groups.map(
      (g) => within(g).queryAllByRole("button", { name: /^Forget/ }).length,
    );
    // This browser, zeus, apollo, New bridges.
    expect(forgets).toEqual([0, 1, 1, 0]);
    expect(
      within(groups[2] as HTMLElement).getByRole("button", {
        name: "Forget the Mic bridge on apollo",
      }),
    ).toBeInTheDocument();
  });

  it("names a bridge channel like a browser one", () => {
    const channel = wavChannel("zeus", 0);
    const api = setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [channel],
            interfaces: [],
          },
        ],
        requests: [],
      },
    });
    const field = within(openMicsScreen()).getByRole("textbox", {
      name: "Name of mics.wav · Input 1",
    });
    act(() => {
      fireEvent.change(field, { target: { value: "Red mic" } });
    });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(api.rename).toHaveBeenCalledWith(channel, "Red mic");
  });

  it("shows a live meter on each row of an open bridge, fed by its levels, and none while it is closed", () => {
    const loud = wavChannel("zeus", 0);
    setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [loud, wavChannel("zeus", 1)],
            interfaces: [],
          },
          {
            bridgeId: "apollo",
            hostName: "apollo",
            open: false,
            channels: [],
            interfaces: [],
          },
        ],
        requests: [],
      },
      kept: [{ ...wavChannel("apollo", 2), name: "Red mic", switchedOn: true }],
      bridgeLevelDbfs: (id) => (id === loud.localMicId ? -12 : null),
    });
    const dialog = openMicsScreen();
    const zeus = within(dialog).getByRole("group", { name: "zeus mic bridge" });
    expect(
      within(zeus)
        .getAllByRole("meter")
        .map((m) => [
          m.getAttribute("aria-label"),
          m.getAttribute("aria-valuenow"),
        ]),
    ).toEqual([
      ["mics.wav · Input 1 level", "-12"],
      ["mics.wav · Input 2 level", "-60"],
    ]);
    const apollo = within(dialog).getByRole("group", {
      name: "apollo mic bridge",
    });
    expect(within(apollo).queryAllByRole("meter")).toEqual([]);
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
            interfaces: [],
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

  it("names a channel with no Admin PIN: the field shows the stored name over its default", () => {
    const api = setup({
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
    const right = within(dialog).getByRole("textbox", {
      name: "Name of USB Audio · Right",
    });
    expect(right).toHaveValue("Red mic");
    const left = within(dialog).getByRole("textbox", {
      name: "Name of USB Audio · Left",
    });
    expect(left).toHaveValue("");
    expect(left).toHaveAttribute("placeholder", "USB Audio · Left");

    act(() => {
      fireEvent.change(left, { target: { value: "Blue mic" } });
    });
    act(() => {
      fireEvent.keyDown(left, { key: "Enter" });
    });
    expect(api.rename).toHaveBeenCalledWith(dongleLeft, "Blue mic");

    act(() => {
      fireEvent.change(right, { target: { value: "" } });
    });
    act(() => {
      fireEvent.blur(right);
    });
    expect(api.rename).toHaveBeenCalledWith(dongleRight, "");
    expect(api.rename).toHaveBeenCalledTimes(2);
  });

  it("does not save a name that did not change", () => {
    const api = setup();
    const left = within(openMicsScreen()).getByRole("textbox", {
      name: "Name of USB Audio · Left",
    });
    act(() => {
      fireEvent.blur(left);
    });
    expect(api.rename).not.toHaveBeenCalled();
  });

  it("shows a kept Local mic whose id is not present as '<name> · not found' with Find it", () => {
    setup({
      kept: [
        {
          localMicId: goneRight.localMicId,
          source: goneRight.source,
          name: "Red mic",
          switchedOn: true,
        },
        {
          localMicId: "browser:stage:other:0",
          source: { ...goneRight.source, deviceId: "other", channel: 0 },
          name: "",
          switchedOn: false,
        },
      ],
    });
    const dialog = openMicsScreen();
    expect(within(dialog).getByText("Red mic · not found")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Zoom H1 · Left · not found"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByRole("button", { name: /^Find it/ }),
    ).toHaveLength(2);
  });

  it("Find it offers only channels that are not yet a Local mic and re-links to the one chosen, with no Admin PIN", () => {
    const api = setup({
      kept: [
        {
          localMicId: goneRight.localMicId,
          source: goneRight.source,
          name: "Red mic",
          switchedOn: true,
        },
        {
          localMicId: dongleRight.localMicId,
          source: dongleRight.source,
          name: "Blue mic",
          switchedOn: false,
        },
      ],
    });
    const dialog = openMicsScreen();
    act(() => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Find it: Red mic" }),
      );
    });
    const choices = within(dialog).getByRole("group", {
      name: "Which channel is Red mic on now?",
    });
    expect(
      within(choices)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["USB Audio · Left", "Webcam Mic"]);
    act(() => {
      fireEvent.click(
        within(choices).getByRole("button", { name: "Webcam Mic" }),
      );
    });
    expect(api.relink).toHaveBeenCalledWith(goneRight.localMicId, webcam);
  });

  describe("an interface not in Pro Audio", () => {
    const CARD = "alsa_card.usb-Focusrite_Scarlett_4i4_4th_Gen_S46-00";
    const inSurround = (switchRefused: boolean) => ({
      bridges: [
        {
          bridgeId: "zeus",
          hostName: "zeus",
          open: true,
          channels: [wavChannel("zeus", 0)],
          interfaces: [
            {
              deviceName: "mics.wav",
              label: "mics.wav",
              channels: 1,
              twin: false,
            },
          ],
          notProAudio: [
            {
              deviceName: CARD,
              cardName: CARD,
              label: "Scarlett 4i4",
              profile: "Analog Surround 2.1",
              switchRefused,
            },
          ],
        },
      ],
      requests: [],
    });

    it("says so in its bridge's group, naming it and its profile, ahead of the channels", () => {
      setup({ bridges: inSurround(false) });
      const zeus = within(openMicsScreen()).getByRole("group", {
        name: "zeus mic bridge",
      });
      const message = within(zeus).getByText(
        "Scarlett 4i4 is in Analog Surround 2.1: only some inputs reach OpenStar",
      );
      const firstChannel = within(zeus).getByRole("textbox", {
        name: "Name of mics.wav · Input 1",
      });
      expect(
        message.compareDocumentPosition(firstChannel) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("switches it to Pro Audio through its bridge with no Admin PIN", () => {
      const api = setup({ bridges: inSurround(false) });
      const zeus = within(openMicsScreen()).getByRole("group", {
        name: "zeus mic bridge",
      });
      fireEvent.click(
        within(zeus).getByRole("button", {
          name: "Switch Scarlett 4i4 to Pro Audio",
        }),
      );
      expect(api.switchBridgeToProAudio).toHaveBeenCalledWith("zeus", CARD);
    });

    it("after a refused switch, says to use the sound settings with the exact pactl line to copy", () => {
      setup({ bridges: inSurround(true) });
      const zeus = within(openMicsScreen()).getByRole("group", {
        name: "zeus mic bridge",
      });
      expect(
        within(zeus).getByText(
          "Set its profile to Pro Audio in your sound settings, or run this on the bridge's computer:",
        ),
      ).toBeInTheDocument();
      const line = within(zeus).getByLabelText(
        "Command to set Scarlett 4i4 to Pro Audio",
      );
      expect(line).toHaveTextContent(
        `pactl set-card-profile ${CARD} pro-audio`,
      );
      expect(line).toHaveClass("select-all");
      expect(
        within(zeus).queryByRole("button", { name: /Pro Audio/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("notes on a bridge group that swapping two identical interfaces' USB ports swaps their mics", () => {
    const twin = (deviceName: string) => ({
      deviceName,
      label: "UMC404HD 192k",
      channels: 4,
      twin: true,
    });
    setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [],
            interfaces: [twin("umc@port1"), twin("umc@port2")],
          },
        ],
        requests: [],
      },
    });
    const dialog = openMicsScreen();
    const zeus = within(dialog).getByRole("group", {
      name: "zeus mic bridge",
    });
    expect(
      within(zeus).getByText(
        "Two identical interfaces: swapping their USB ports swaps their mics",
      ),
    ).toBeInTheDocument();
  });

  it("says 'use one or the other' on a bridge group whose interface This browser reads too, and nothing on others", () => {
    const usbAudio = {
      ...wavChannel("zeus", 0),
      source: { ...wavChannel("zeus", 0).source, label: "USB Audio" },
    };
    setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [usbAudio],
            interfaces: [
              {
                deviceName: "mics.wav",
                label: "USB Audio",
                channels: 1,
                twin: false,
              },
            ],
          },
          {
            bridgeId: "apollo",
            hostName: "apollo",
            open: true,
            channels: [wavChannel("apollo", 0)],
            interfaces: [],
          },
        ],
        requests: [],
      },
    });
    const dialog = openMicsScreen();
    const note =
      "This browser reads one of these interfaces too: use one or the other";
    expect(
      within(
        within(dialog).getByRole("group", { name: "zeus mic bridge" }),
      ).getByText(note),
    ).toBeInTheDocument();
    expect(
      within(
        within(dialog).getByRole("group", { name: "apollo mic bridge" }),
      ).queryByText(note),
    ).toBeNull();
  });

  it("Find it re-links a bridge Local mic its open bridge no longer offers, to one of its new channels", () => {
    const moved = wavChannel("zeus", 3);
    const api = setup({
      bridges: {
        bridges: [
          {
            bridgeId: "zeus",
            hostName: "zeus",
            open: true,
            channels: [wavChannel("zeus", 0), wavChannel("zeus", 1)],
            interfaces: [],
          },
        ],
        requests: [],
      },
      kept: [
        { ...moved, name: "Red mic", switchedOn: true },
        { ...wavChannel("zeus", 0), name: "Blue mic", switchedOn: true },
      ],
    });
    const dialog = openMicsScreen();
    const zeus = within(dialog).getByRole("group", {
      name: "zeus mic bridge",
    });
    expect(within(zeus).getByText("Red mic · not found")).toBeInTheDocument();
    act(() => {
      fireEvent.click(
        within(zeus).getByRole("button", { name: "Find it: Red mic" }),
      );
    });
    const choices = within(zeus).getByRole("group", {
      name: "Which channel is Red mic on now?",
    });
    expect(
      within(choices)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["mics.wav · Input 2"]);
    act(() => {
      fireEvent.click(
        within(choices).getByRole("button", { name: "mics.wav · Input 2" }),
      );
    });
    expect(api.relink).toHaveBeenCalledWith(
      moved.localMicId,
      wavChannel("zeus", 1),
    );
  });

  it("Find it says so when no channel is free to take over", () => {
    setup({
      open: new Map([["webcam", 1]]),
      kept: [
        {
          localMicId: goneRight.localMicId,
          source: goneRight.source,
          name: "Red mic",
          switchedOn: true,
        },
        {
          localMicId: webcam.localMicId,
          source: webcam.source,
          name: "",
          switchedOn: true,
        },
      ],
    });
    const dialog = openMicsScreen();
    act(() => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Find it: Red mic" }),
      );
    });
    expect(
      within(dialog).getByText(
        "No new channel to pick. Is the mic plugged in?",
      ),
    ).toBeInTheDocument();
  });
});

describe("a Local mic's Mic threshold on its row", () => {
  afterEach(() => {
    act(() => {
      stageMicSettings().set(null);
    });
  });

  const redMic: LocalMic = {
    localMicId: dongleRight.localMicId,
    source: dongleRight.source,
    name: "Red mic",
    switchedOn: true,
  };
  const red = { kind: "localMic" as const, localMicId: redMic.localMicId };
  const load = (setBy: "calibration" | "hand" | null) => {
    act(() => {
      stageMicSettings().set({
        stageOutput: "Speakers",
        mics:
          setBy === null
            ? []
            : [
                {
                  mic: red,
                  settings: {
                    micThreshold: { referenceDbfs: -44, setBy },
                  },
                },
              ],
      });
    });
  };
  const volume = (v: number) => {
    act(() => {
      toStage?.onMessage({ type: "volume", volume: v, stepped: true });
    });
  };
  const thresholdsSent = () =>
    sent.flatMap((m) => (m.type === "setMicThreshold" ? [m] : []));
  const row = () =>
    screen
      .getByRole("switch", { name: "Red mic switched on" })
      .closest("li") as HTMLElement;
  const slider = () =>
    within(row()).getByRole("slider", { name: "Red mic threshold" });
  const lineAt = () => Number(slider().dataset.thresholdDbfs);

  it("draws a line on each live meter at the effective Mic threshold, with no number", () => {
    setup({ kept: [redMic] });
    load("calibration");
    volume(40);
    openMicsScreen();
    const level = 40 * Math.log10(40 / 80);
    expect(lineAt()).toBeCloseTo(-44 + level);
    // A channel with nothing stored: the Local mic default.
    const webcamRow = screen
      .getByRole("switch", { name: "Webcam Mic switched on" })
      .closest("li") as HTMLElement;
    expect(
      Number(within(webcamRow).getByRole("slider").dataset.thresholdDbfs),
    ).toBeCloseTo(-40 + level);
    expect(slider().textContent).toBe("");
  });

  it("says what set the current value: Calibration, a hand, or nothing for the default", () => {
    setup({ kept: [redMic] });
    load("calibration");
    openMicsScreen();
    expect(within(row()).getByText("set by Calibration")).toBeVisible();
    load("hand");
    expect(within(row()).getByText("set by hand")).toBeVisible();
    load(null);
    expect(within(row()).queryByText(/^set by/)).toBeNull();
  });

  it("moves the line 1 dB with ←/→ while focused, saving each step at once for the current Stage output, marked set by hand", () => {
    setup({ kept: [redMic] });
    load("calibration");
    openMicsScreen();
    act(() => {
      slider().focus();
    });
    press("ArrowLeft");
    press("ArrowLeft");
    press("ArrowRight");
    expect(thresholdsSent().map((m) => m.referenceDbfs)).toEqual([
      -45, -46, -45,
    ]);
    expect(thresholdsSent()[0]).toEqual({
      type: "setMicThreshold",
      stageOutput: "Speakers",
      localMicId: redMic.localMicId,
      referenceDbfs: -45,
    });
    expect(lineAt()).toBe(-45);
    expect(within(row()).getByText("set by hand")).toBeVisible();
    // The one stored value the Line-up seat reads too.
    expect(stageMicSettings().storedFor(red)).toEqual({
      micThreshold: { referenceDbfs: -45, setBy: "hand" },
    });
  });

  it("cannot be set before the Stage output's stored values have loaded, then can", () => {
    setup({ kept: [redMic] });
    openMicsScreen();
    expect(slider()).toHaveAttribute("aria-disabled", "true");
    act(() => {
      slider().focus();
    });
    press("ArrowLeft");
    expect(thresholdsSent()).toEqual([]);

    load("calibration");
    expect(slider()).not.toHaveAttribute("aria-disabled");
    act(() => {
      slider().focus();
    });
    press("ArrowLeft");
    expect(thresholdsSent().map((m) => m.referenceDbfs)).toEqual([-45]);
  });

  it("drags the line, storing it at the reference volume", () => {
    setup({ kept: [redMic] });
    load("calibration");
    volume(40);
    openMicsScreen();
    const meter = within(row()).getByRole("meter");
    // jsdom has no layout: a 600 px meter, 10 px per dB from −60 to 0.
    vi.spyOn(meter, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 0, width: 600, height: 24 }),
    );
    act(() => {
      fireEvent.pointerDown(meter, { clientX: 400, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(meter, { clientX: 250, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(meter, { clientX: 250, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(meter, { clientX: 600, pointerId: 1 });
    });
    // −30 then −45 dBFS on the meter, at volume 40 (≈ −12.04 dB).
    expect(thresholdsSent().map((m) => m.referenceDbfs)).toEqual([
      -17.96, -32.96,
    ]);
    expect(lineAt()).toBeCloseTo(-45);
  });

  it("shows a hand setting made elsewhere (the Line-up seat) at once", () => {
    setup({ kept: [redMic] });
    load("calibration");
    openMicsScreen();
    act(() => {
      stageMicSettings().setByHand(redMic.localMicId, -50);
    });
    expect(lineAt()).toBe(-50);
    expect(within(row()).getByText("set by hand")).toBeVisible();
  });

  it("sets nothing while no Stage output's values are loaded", () => {
    setup({ kept: [redMic] });
    openMicsScreen();
    act(() => {
      slider().focus();
    });
    press("ArrowLeft");
    expect(thresholdsSent()).toEqual([]);
  });
});

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

describe("Calibrate this mic now", () => {
  const offer = () =>
    screen.queryByRole("button", { name: "Calibrate this mic now" });
  const switchOn = (name: string) => {
    act(() => {
      fireEvent.click(screen.getByRole("switch", { name }));
    });
  };

  it("is offered when a Local mic is switched on, and starts the run with only that Local mic", () => {
    setup();
    openMicsScreen();
    expect(offer()).toBeNull();
    switchOn("USB Audio · Left switched on");
    act(() => {
      fireEvent.click(offer() as HTMLElement);
    });
    expect(sent.at(-1)).toEqual({
      type: "calibrateLocalMicNow",
      localMicId: dongleLeft.localMicId,
    });
  });

  it("is a suggestion: Not now leaves the Local mic switched on and sends nothing", () => {
    const api = setup();
    openMicsScreen();
    switchOn("USB Audio · Left switched on");
    const before = sent.length;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    });
    expect(offer()).toBeNull();
    expect(sent.length).toBe(before);
    expect(api.setSwitchedOn).toHaveBeenCalledTimes(1);
    expect(api.setSwitchedOn).toHaveBeenCalledWith(dongleLeft, true);
  });

  it("is not offered when a Local mic is switched off", () => {
    setup({
      kept: [
        {
          localMicId: dongleLeft.localMicId,
          source: dongleLeft.source,
          name: "",
          switchedOn: true,
        },
      ],
    });
    openMicsScreen();
    switchOn("USB Audio · Left switched on");
    expect(offer()).toBeNull();
  });

  it("on a Mic bridge with an interface not in Pro Audio, comes after the profile message", () => {
    const channel = wavChannel("zeus", 0);
    const bridge = (notProAudio: boolean): MicBridges => ({
      bridges: [
        {
          bridgeId: "zeus",
          hostName: "zeus",
          open: true,
          channels: [channel],
          interfaces: [],
          ...(notProAudio
            ? {
                notProAudio: [
                  {
                    deviceName: "scarlett",
                    cardName: "scarlett",
                    label: "Scarlett 4i4",
                    profile: "Analog Surround 2.1",
                    switchRefused: false,
                  },
                ],
              }
            : {}),
        },
      ],
      requests: [],
    });
    setup({ bridges: bridge(true) });
    openMicsScreen();
    switchOn("mics.wav · Input 1 switched on");
    // The profile message asks to switch first; the offer waits for it.
    expect(
      screen.getByText(
        "Scarlett 4i4 is in Analog Surround 2.1: only some inputs reach OpenStar",
      ),
    ).toBeInTheDocument();
    expect(offer()).toBeNull();
    withBridges(bridge(false));
    act(() => {
      fireEvent.click(offer() as HTMLElement);
    });
    expect(sent.at(-1)).toEqual({
      type: "calibrateLocalMicNow",
      localMicId: channel.localMicId,
    });
  });
});
