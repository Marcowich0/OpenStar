import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { SCENES } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";
import type { SceneId } from "../frame/scenes";
import { VOLUME_PILL_MS } from "./volumePill";

// The song browser needs the Library's Songs; this test is not about it.
const NO_BROWSER = { ...SCENES, songBrowser: { component: () => null } };

const setVolume = vi.fn();
vi.mock("../playback/stageAudio", () => ({
  stageAudio: () => ({ chain: () => ({ setVolume }) }),
}));

beforeEach(() => {
  setVolume.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const party: PartySnapshot = {
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
};

function setup(scene?: SceneId) {
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
  render(
    <StageFrame
      store={store}
      scenes={NO_BROWSER}
      {...(scene ? { chooseScene: () => scene } : {})}
    />,
  );
  const server = (volume: number, stepped: boolean) => {
    act(() => handlers?.onMessage({ type: "volume", volume, stepped }));
  };
  act(() => {
    handlers?.onConnection("open");
    handlers?.onMessage({
      type: "liveState",
      stageId: "main",
      party,
      isStage: true,
    });
  });
  const steps = () =>
    sent.flatMap((m) => (m.type === "stepVolume" ? [m.step] : []));
  return { server, steps };
}

function press(
  key: string,
  target: Element = document.activeElement ?? document.body,
) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

const pill = () => screen.queryByTestId("volume-pill");

describe("the OpenStar volume on the Stage", () => {
  it("+ and - ask the server for one step up or down", () => {
    const { steps } = setup();
    press("+");
    press("-");
    press("="); // the + key without Shift
    expect(steps()).toEqual(["up", "down", "up"]);
  });

  it("works on every scene, a Song included, and with an overlay open", () => {
    const { steps } = setup("sing");
    press("+");
    expect(steps()).toEqual(["up"]);

    const other = setup();
    press("q");
    expect(screen.getAllByRole("dialog")).not.toHaveLength(0);
    press("-");
    expect(other.steps()).toEqual(["down"]);
  });

  it("leaves + and - to a text field", () => {
    const { steps } = setup();
    const field = document.createElement("input");
    document.querySelector("[data-stage-frame]")?.append(field);
    field.focus();
    press("-", field);
    expect(steps()).toEqual([]);
  });

  it("applies the server's volume to the gain chain at once", () => {
    const { server } = setup();
    expect(setVolume).not.toHaveBeenCalled();
    server(70, false);
    expect(setVolume).toHaveBeenLastCalledWith(70);
    server(75, true);
    expect(setVolume).toHaveBeenLastCalledWith(75);
  });

  it("shows the ink pill for about 1.5 s on each step, not when the output changes", () => {
    vi.useFakeTimers();
    const { server } = setup();
    server(80, false);
    expect(pill()).toBeNull();

    server(85, true);
    expect(pill()).toHaveTextContent("Volume 85");
    act(() => {
      vi.advanceTimersByTime(VOLUME_PILL_MS - 100);
    });
    // Another step keeps it up for another 1.5 s.
    server(90, true);
    expect(pill()).toHaveTextContent("Volume 90");
    act(() => {
      vi.advanceTimersByTime(VOLUME_PILL_MS - 100);
    });
    expect(pill()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(pill()).toBeNull();

    // A step at the top shows the pill too.
    server(100, true);
    server(100, true);
    expect(pill()).toHaveTextContent("Volume 100");
  });

  it("is not a toast", () => {
    vi.useFakeTimers();
    const { server } = setup();
    server(85, true);
    expect(
      screen.getByRole("status", { name: "Party changes" }),
    ).not.toContainElement(pill());
  });
});
