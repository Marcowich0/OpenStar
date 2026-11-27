// Which Stage event plays which UI sound (#261), with the real engine on a
// fake AudioContext.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import { profilesQuery } from "../../api/queries";
import type { ChangeEvent } from "../../generated/ChangeEvent";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import type { SceneDefinition } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";
import type { SceneId } from "../frame/scenes";
import { startedSources } from "./fakeSynthContext";
import { StageSoundsProvider } from "./StageSounds";
import { recordedSounds } from "./testSounds";

const party: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "tangerine",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
  ],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
};

function setUp(children: React.ReactNode = null) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const recorded = recordedSounds();
  render(
    <StageSoundsProvider store={store} sounds={recorded.sounds}>
      {children}
    </StageSoundsProvider>,
  );
  const send = (message: ServerMessage) => {
    act(() => {
      handlers?.onMessage(message);
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  send({ type: "liveState", stageId: "main", party, isStage: true });
  return { ...recorded, send };
}

describe("UI sounds on the Stage", () => {
  it("counts a key or a press as the user gesture audio waits for", () => {
    const { gestures, context } = setUp();
    expect(gestures()).toBe(0);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.pointerDown(document.body);
    expect(gestures()).toBe(2);
    expect(context.state).toBe("running");
  });

  it("ticks when the focus ring moves inside one layer", () => {
    const { played, context } = setUp(
      <div data-stage-layer="scene">
        <button type="button">One</button>
        <button type="button">Two</button>
      </div>,
    );
    fireEvent.keyDown(window, { key: "ArrowRight" });
    act(() => {
      screen.getByText("One").focus();
    });
    act(() => {
      screen.getByText("Two").focus();
    });
    expect(played).toEqual(["focus"]);
    expect(startedSources(context).length).toBeGreaterThan(0);
  });

  it("does not tick when a layer opens or closes and takes the focus", () => {
    const { played } = setUp(
      <>
        <div data-stage-layer="scene">
          <button type="button">Songs</button>
        </div>
        <div data-stage-layer="overlay">
          <button type="button">Close</button>
        </div>
      </>,
    );
    act(() => {
      screen.getByText("Songs").focus();
    });
    act(() => {
      screen.getByText("Close").focus();
    });
    act(() => {
      screen.getByText("Songs").focus();
    });
    expect(played).toEqual([]);
  });

  it("pops on a click (or Enter) on a button, a covered card or a pick-list row", () => {
    const { played } = setUp(
      <>
        <button type="button">Plain</button>
        <div role="button" data-stage-focus="">
          <span>Cover</span>
        </div>
      </>,
    );
    fireEvent.click(screen.getByText("Plain"));
    fireEvent.click(screen.getByText("Cover"));
    expect(played).toEqual(["select", "select"]);
  });

  it("plays back for a control that closes an overlay", () => {
    const { played } = setUp(
      <>
        <button type="button" data-stage-back="">
          Close
        </button>
        <div data-stage-back="" data-testid="veil" />
      </>,
    );
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByTestId("veil"));
    expect(played).toEqual(["back", "back"]);
  });

  it("bonks on a click on a greyed button", () => {
    const { played } = setUp(
      <button type="button" aria-disabled="true">
        Start
      </button>,
    );
    fireEvent.click(screen.getByText("Start"));
    expect(played).toEqual(["refuse"]);
  });

  it("leaves a control that sounds itself to its own cues", () => {
    const { played } = setUp(
      <button type="button" data-ui-cue="">
        Hold
      </button>,
    );
    fireEvent.click(screen.getByText("Hold"));
    expect(played).toEqual([]);
  });

  it("plays back for an Esc the Stage acted on, and nothing for one it ignored", async () => {
    const { played } = setUp();
    const handled = (event: KeyboardEvent) => {
      event.preventDefault();
    };
    window.addEventListener("keydown", handled);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", handled);
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(played).toEqual(["back"]);
  });

  it("bonks when the server refuses an action", () => {
    const { played, send } = setUp();
    send({ type: "rejected", reason: { code: "wrongPin" } });
    send({ type: "rejected", reason: { code: "wrongPin" } });
    expect(played).toEqual(["refuse", "refuse"]);
  });

  it("chimes for each new toast", () => {
    const { played, send } = setUp();
    const moved = (title: string): ServerMessage => ({
      type: "partyChanged",
      party,
      change: {
        actor: { kind: "member", memberId: 1 },
        event: {
          code: "requestMovedUp",
          params: { requestId: 1, songId: 1, title },
        },
      },
    });
    send(moved("Africa"));
    send(moved("Toxic"));
    expect(played).toEqual(["toast", "toast"]);
  });

  it("ducks while a Song plays and not after", () => {
    const { ducked, send } = setUp();
    expect(ducked.at(-1)).toBe(false);
    const quiet: ChangeEvent = {
      actor: { kind: "stage" },
      event: { code: "partyStarted", params: { joinCode: "4821" } },
    };
    const playing: PartySnapshot = {
      ...party,
      playing: { requestId: 1, songId: 1, paused: false },
    };
    send({ type: "partyChanged", party: playing, change: quiet });
    expect(ducked.at(-1)).toBe(true);
    send({ type: "partyChanged", party, change: quiet });
    expect(ducked.at(-1)).toBe(false);
  });
});

// Two buttons in the scene, so the focus ring has somewhere to go.
function TwoButtons() {
  return (
    <>
      <button type="button" data-stage-default="">
        One
      </button>
      <button type="button">Two</button>
    </>
  );
}

const scenes: Record<SceneId, SceneDefinition> = {
  songBrowser: { component: TwoButtons },
  lineUp: { component: TwoButtons },
  sing: { component: TwoButtons, fullScreen: true },
  results: { component: TwoButtons },
  stageMoved: { component: TwoButtons },
};

describe("UI sounds in the Stage frame", () => {
  it("ticks, pops and plays back as the host moves, opens and closes", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(profilesQuery.queryKey, []);
    const recorded = recordedSounds();
    const store = createLiveStore(() => ({
      send: () => true,
      close: () => {},
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <StageSoundsProvider store={store} sounds={recorded.sounds}>
          <StageFrame
            store={store}
            takeStageBack={() => {}}
            scenes={scenes}
            chooseScene={() => "songBrowser"}
          />
        </StageSoundsProvider>
      </QueryClientProvider>,
    );
    const afterKeys = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    expect(screen.getByText("One")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByText("Two")).toHaveFocus();
    expect(recorded.played).toEqual(["focus"]);

    fireEvent.click(screen.getByRole("button", { name: /People/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await afterKeys();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(recorded.played).toEqual(["focus", "select", "back"]);

    fireEvent.keyDown(window, { key: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await afterKeys();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(recorded.played).toEqual(["focus", "select", "back", "back"]);
    expect(startedSources(recorded.context).length).toBeGreaterThan(0);
  });
});
