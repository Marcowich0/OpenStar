import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Request } from "../../generated/Request";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { SCENES } from "./sceneComponents";
import { StageFrame, type StageFrameProps } from "./StageFrame";
import { StagePickList, StagePickListEntry } from "./StagePickList";
import { useStageFrame, useStageKeys } from "./stageFrameContext";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const request = (requestId: number): Request => ({
  requestId,
  kind: "song",
  songId: requestId,
  requestedPlayers: [],
  adder: null,
});

const member = (memberId: number): PartyMember => ({
  memberId,
  identity: { kind: "profile", profileId: memberId },
  colour: "cherry",
  favouriteTaken: false,
  onPhone: false,
  singing: false,
});

const party = (over: Partial<PartySnapshot> = {}): PartySnapshot => ({
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
  ...over,
});

/**
 * These tests are about the frame, so the song browser is a stand-in: the
 * Join code and one default button (the real scene has its own tests in
 * `scenes/songBrowser/`, and needs the Library's Songs).
 */
function BrowserStandIn() {
  const { store, openOverlay } = useStageFrame();
  const joinCode = useLive(
    (live) => live.stage?.party?.joinCode ?? null,
    store,
  );
  return (
    <div>
      <p data-testid="party-join-code">{joinCode}</p>
      <span data-stage-default>
        <Button
          onPress={() => {
            openOverlay("songs");
          }}
        >
          Or browse songs here
        </Button>
      </span>
    </div>
  );
}

const FRAME_SCENES = { ...SCENES, songBrowser: { component: BrowserStandIn } };

function setup(
  snapshot: PartySnapshot = party(),
  options: Pick<StageFrameProps, "scenes" | "chooseScene"> = {},
) {
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
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  const takeStageBack = vi.fn();
  // The Songs and Queue overlays read queries; these tests fetch nothing.
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <StageFrame
        store={store}
        takeStageBack={takeStageBack}
        scenes={FRAME_SCENES}
        {...options}
      />
    </QueryClientProvider>,
  );
  live((h) => {
    h.onConnection("open");
    h.onMessage({
      type: "liveState",
      stageId: "main",
      party: snapshot,
      isStage: true,
    });
  });
  const changeParty = (next: PartySnapshot) => {
    live((h) => {
      h.onMessage({
        type: "partyChanged",
        party: next,
        change: {
          actor: { kind: "stage" },
          event: { code: "partyStarted", params: { joinCode: next.joinCode } },
        },
      });
    });
  };
  return { store, sent, live, takeStageBack, changeParty, ...view };
}

function key(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key,
      ...init,
    });
  });
}

function keyUp(key: string) {
  act(() => {
    fireEvent.keyUp(document.activeElement ?? document.body, { key });
  });
}

const scene = (container: HTMLElement) =>
  container.querySelector("[data-stage-frame]")?.getAttribute("data-scene");

const overlay = () => screen.queryByRole("dialog");

describe("StageFrame scenes", () => {
  it("rests on the song browser with the Join code and no navigation chrome", () => {
    const { container } = setup();
    expect(scene(container)).toBe("songBrowser");
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("4821");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("switches scene when the server's state changes", () => {
    const { container, changeParty, live } = setup();
    changeParty(party({ queue: [request(1)], head: 1 }));
    expect(scene(container)).toBe("lineUp");
    live((h) => {
      h.onMessage({ type: "stageMoved" });
    });
    expect(scene(container)).toBe("stageMoved");
    expect(screen.getByTestId("stage-moved")).toBeInTheDocument();
  });

  it("draws a scene in the 1920 × 1080 reference frame, scaled to the screen", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(3840);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(2160);
    const { container } = setup();
    const box = container.querySelector<HTMLElement>("[data-reference-box]");
    expect(box?.style.width).toBe("1920px");
    expect(box?.style.height).toBe("1080px");
    expect(box?.style.transform).toContain("scale(2)");
  });

  it("starts a scene focused on its default control", () => {
    setup();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Or browse songs here" }),
    );
  });
});

describe("StageFrame overlays", () => {
  it("toggles Songs, Queue and People with S, Q and P", () => {
    setup(party({ members: [member(1), member(2)] }));
    key("s");
    expect(overlay()).toHaveAccessibleName("Songs");
    key("q");
    expect(overlay()).toHaveAccessibleName("Queue");
    key("P");
    expect(overlay()).toHaveAccessibleName("Tonight's Party");
    expect(screen.getByText("2 of 12 colours taken")).toBeInTheDocument();
    key("p");
    expect(overlay()).toBeNull();
  });

  it("puts an overlay on the veil, in a cream modal", () => {
    setup();
    key("q");
    expect(screen.getByTestId("overlay-veil")).toHaveClass("bg-veil");
    expect(overlay()).toHaveClass("bg-cream", "rounded-card");
    act(() => {
      fireEvent.click(screen.getByTestId("overlay-veil"));
    });
    expect(overlay()).toBeNull();
  });

  it("opens the overlays from the pill row, with live counts", () => {
    const { changeParty } = setup(party({ members: [member(1)] }));
    const pills = within(screen.getByTestId("pill-row"));
    expect(pills.getByRole("button", { name: "Queue 0" })).toBeInTheDocument();
    expect(pills.getByRole("button", { name: "People 1" })).toBeInTheDocument();
    changeParty(
      party({
        members: [member(1), member(2)],
        queue: [request(1), request(2), request(3), request(4)],
      }),
    );
    act(() => {
      fireEvent.click(pills.getByRole("button", { name: "Queue 4" }));
    });
    expect(overlay()).toHaveAccessibleName("Queue");
    expect(
      within(screen.getByRole("list", { name: "Queue" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(4);
    act(() => {
      fireEvent.click(pills.getByRole("button", { name: "People 2" }));
    });
    expect(overlay()).toHaveAccessibleName("Tonight's Party");
  });

  it("holds a Setup menu of Mics, Calibrate mics and Check A/V sync", () => {
    const { sent } = setup();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    });
    const menu = screen.getByRole("menu", { name: "Setup" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Mics", "Calibrate mics", "Check A/V sync"]);
    act(() => {
      fireEvent.click(
        within(menu).getByRole("menuitem", { name: "Calibrate mics" }),
      );
    });
    expect(screen.queryByRole("menu")).toBeNull();
    // The server holds the run: the overlay opens once it says so.
    expect(sent.at(-1)).toEqual({ type: "openCalibration" });
    expect(overlay()).toBeNull();
  });

  it("shows Setup on the song browser and the Line-up only", () => {
    const { changeParty } = setup();
    changeParty(party({ queue: [request(1)], head: 1 }));
    expect(screen.getByRole("button", { name: "Setup" })).toBeInTheDocument();
  });

  it("closes the Setup menu on Esc and gives the focus back to Setup", () => {
    setup();
    const setupPill = screen.getByRole("button", { name: "Setup" });
    // The mouse hovers the pill (moving the focus there), then clicks it.
    act(() => {
      fireEvent.pointerOver(setupPill);
      fireEvent.click(setupPill);
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // S does nothing while a pick list is open.
    key("s");
    expect(overlay()).toBeNull();
    key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Setup" }),
    );
  });

  it("closes an open pick list first, then the overlay, on Esc", () => {
    // A scene that opens a pick list with L, whatever is on top.
    function ListScene() {
      const [open, setOpen] = useState(false);
      useStageKeys(
        {
          l: () => {
            setOpen(true);
          },
        },
        { global: true },
      );
      return open ? (
        <StagePickList
          aria-label="List"
          onClose={() => {
            setOpen(false);
          }}
        >
          <StagePickListEntry onPick={() => {}}>Entry</StagePickListEntry>
        </StagePickList>
      ) : null;
    }
    setup(party(), {
      scenes: { ...SCENES, songBrowser: { component: ListScene } },
    });
    key("q");
    key("l");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(overlay()).toHaveAccessibleName("Queue");
    key("Escape");
    expect(overlay()).toBeNull();
  });

  it("hides the pill row and opens no overlay while a Song plays", () => {
    const { changeParty } = setup(party(), {
      chooseScene: (stage) =>
        stage?.party?.head == null ? "songBrowser" : "sing",
    });
    key("q");
    expect(overlay()).toHaveAccessibleName("Queue");
    changeParty(party({ queue: [request(1)], head: 1 }));
    expect(overlay()).toBeNull();
    expect(screen.queryByTestId("pill-row")).toBeNull();
    key("q");
    key("s");
    expect(overlay()).toBeNull();
  });

  it("gives the old Stage no pill row and no overlays", () => {
    const { live } = setup();
    live((h) => {
      h.onMessage({ type: "stageMoved" });
    });
    expect(screen.queryByTestId("pill-row")).toBeNull();
    key("q");
    expect(overlay()).toBeNull();
  });
});

describe("StageFrame focus", () => {
  function placeAt(name: string, x: number, y: number) {
    const element = screen.getByRole("button", { name });
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      new DOMRect(x, y, 100, 50),
    );
    return element;
  }

  it("moves the one focus with the arrows to the nearest control that way", () => {
    setup();
    const browse = placeAt("Or browse songs here", 800, 800);
    const songs = placeAt("Songs", 1200, 50);
    const queue = placeAt("Queue 0", 1350, 50);
    placeAt("People 0", 1500, 50);
    placeAt("Setup", 1650, 50);
    expect(document.activeElement).toBe(browse);
    key("ArrowUp");
    expect(document.activeElement).toBe(songs);
    key("ArrowRight");
    expect(document.activeElement).toBe(queue);
    key("ArrowDown");
    expect(document.activeElement).toBe(browse);
    key("ArrowDown");
    expect(document.activeElement).toBe(browse);
  });

  it("moves the focus to the control the mouse hovers", () => {
    setup();
    const queue = screen.getByRole("button", { name: "Queue 0" });
    act(() => {
      fireEvent.pointerOver(queue);
    });
    expect(document.activeElement).toBe(queue);
  });

  it("keeps the focus inside an open overlay", () => {
    setup();
    key("q");
    const dialog = overlay();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    act(() => {
      fireEvent.pointerOver(screen.getByRole("button", { name: "Queue 0" }));
    });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    key("Tab");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    key("Escape");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Or browse songs here" }),
    );
  });

  it("picks the focused control with Enter", () => {
    setup();
    // The focused "Or browse songs here" opens Songs.
    key("Enter");
    keyUp("Enter");
    expect(overlay()).toHaveAccessibleName("Songs");
  });
});

describe("StageFrame disabled controls", () => {
  it("shakes a disabled control picked with Enter, and does nothing else", () => {
    const onPress = vi.fn();
    function DisabledScene() {
      return (
        <span data-stage-default>
          <Button isDisabled onPress={onPress}>
            Start
          </Button>
        </span>
      );
    }
    setup(party(), {
      scenes: { ...SCENES, songBrowser: { component: DisabledScene } },
    });
    const start = screen.getByRole("button", { name: "Start" });
    expect(document.activeElement).toBe(start);
    key("Enter");
    keyUp("Enter");
    expect(start).toHaveAttribute("data-shaking");
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("StageFrame hold to confirm", () => {
  it("runs New party after Enter is held 700 ms on the hold button", () => {
    vi.useFakeTimers();
    const { sent } = setup();
    key("p");
    const newParty = screen.getByRole("button", { name: "New party" });
    act(() => {
      newParty.focus();
    });
    key("Enter");
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS - 1);
    });
    expect(sent).not.toContainEqual({ type: "newParty" });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    keyUp("Enter");
    expect(sent).toContainEqual({ type: "newParty" });
  });

  it("cancels the hold when Enter comes up early", () => {
    vi.useFakeTimers();
    const { sent } = setup();
    key("p");
    act(() => {
      screen.getByRole("button", { name: "New party" }).focus();
    });
    key("Enter");
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS / 2);
    });
    keyUp("Enter");
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    expect(sent).not.toContainEqual({ type: "newParty" });
  });

  it("takes the Stage back after a mouse hold on Stage moved here", () => {
    vi.useFakeTimers();
    const { live, takeStageBack } = setup();
    live((h) => {
      h.onMessage({ type: "stageMoved" });
    });
    const button = screen.getByRole("button", {
      name: "Make this the Stage again",
    });
    act(() => {
      fireEvent.pointerDown(button);
    });
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    expect(takeStageBack).toHaveBeenCalledOnce();
  });
});

describe("useStageKeys", () => {
  it("lets a scene bind keys before the frame's own, on its layer only", () => {
    const onSpace = vi.fn();
    function BoundScene() {
      // S is passed on (returning false), so the frame still opens Songs.
      useStageKeys({ " ": onSpace, s: () => false });
      return <button type="button">Bound</button>;
    }
    setup(party(), {
      scenes: { ...SCENES, songBrowser: { component: BoundScene } },
    });
    key(" ");
    expect(onSpace).toHaveBeenCalledOnce();
    key("s");
    expect(overlay()).toHaveAccessibleName("Songs");
    // The Songs overlay is on top now: the scene's binding stays quiet.
    key(" ");
    expect(onSpace).toHaveBeenCalledOnce();
  });
});
