import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";

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
  };
  render(
    <LocalMicsContext value={api}>
      <StageFrame store={store} scenes={NO_BROWSER} />
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
    // A closed bridge's Local mic is closed, not "not found" in This browser.
    expect(within(dialog).queryByText("Red mic · not found")).toBeNull();
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
          },
          { bridgeId: "apollo", hostName: "apollo", open: false, channels: [] },
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
