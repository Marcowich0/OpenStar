import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { StageFrame } from "../stage/frame/StageFrame";
import type { CaptureSnapshot } from "./localMicCapture";
import { LocalMicsContext, type LocalMicsApi } from "./LocalMics";
import {
  browserChannels,
  matchLocalMics,
  type BrowserChannel,
} from "./localMics";

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
    match: matchLocalMics({
      stageBrowser: "stage",
      devices: snapshot.devices,
      open,
      kept,
    }),
    rename: vi.fn(),
    relink: vi.fn(),
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
