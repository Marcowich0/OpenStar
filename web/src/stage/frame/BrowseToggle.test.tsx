// The song browser over a waiting Line-up (`BrowseToggle.tsx`, the frame's
// `browsing`): its pill, its banner, `H`, and when the Line-up comes back.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { songsQuery } from "../../api/queries";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Request } from "../../generated/Request";
import type { SongSummary } from "../../generated/SongSummary";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { Button } from "../../ui/Button";
import { SCENES } from "./sceneComponents";
import { StageFrame } from "./StageFrame";

const request = (requestId: number, songId = requestId): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

const song = (id: number, title: string): SongSummary => ({
  id,
  path: `${title}.txt`,
  artist: "Kiri",
  title,
  duet: false,
  identity: { kind: "artistTitle", artist: "Kiri", title, duet: false },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
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

const waiting = (head = 1, queue = [request(1), request(2)]) =>
  party({ queue, head });

/** Stand-ins: the song browser with its search box, the Line-up with Start. */
function BrowserStandIn() {
  return (
    <div>
      <input aria-label="Search" />
      <span data-stage-default>
        <Button onPress={() => {}}>Sing!</Button>
      </span>
    </div>
  );
}

function LineUpStandIn() {
  return (
    <span data-stage-default>
      <Button onPress={() => {}}>Start</Button>
    </span>
  );
}

function setup(snapshot: PartySnapshot) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  queries.setQueryData(songsQuery().queryKey, {
    songs: [song(1, "Islands"), song(2, "Wave")],
    filters: {
      languages: [],
      genres: [],
      years: [],
      editions: [],
      creators: [],
      duet: [],
      hasVideo: [],
      length: null,
    },
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <StageFrame
        store={store}
        scenes={{
          ...SCENES,
          songBrowser: { component: BrowserStandIn },
          lineUp: { component: LineUpStandIn },
          sing: { component: () => <p>Singing</p> },
        }}
      />
    </QueryClientProvider>,
  );
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
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
  const scene = () =>
    view.container
      .querySelector("[data-stage-frame]")
      ?.getAttribute("data-scene");
  return { changeParty, scene };
}

function key(name: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: name });
  });
}

const click = (element: HTMLElement) => {
  act(() => {
    fireEvent.click(element);
  });
};

const browsePill = () => screen.queryByRole("button", { name: "Browse songs" });
const banner = () => screen.queryByTestId("browse-up-next");

describe("the song browser over a waiting Line-up", () => {
  it("leaves the Line-up with Browse songs and comes back with Up next", () => {
    const { scene } = setup(waiting());
    expect(scene()).toBe("lineUp");
    expect(banner()).toBeNull();
    click(browsePill() as HTMLElement);
    expect(scene()).toBe("songBrowser");
    expect(browsePill()).toBeNull();
    // The banner names the head's Song.
    const back = screen.getByRole("button", {
      name: "Up next: Islands. Back to Line-up",
    });
    expect(back).toHaveTextContent("Islands");
    // The song browser starts on its own default control.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sing!" }),
    );
    click(back);
    expect(scene()).toBe("lineUp");
    expect(banner()).toBeNull();
  });

  it("toggles with H, but not while typing or with a layer open", () => {
    const { scene } = setup(waiting());
    key("h");
    expect(scene()).toBe("songBrowser");
    const search = screen.getByRole("textbox", { name: "Search" });
    act(() => {
      search.focus();
    });
    key("h");
    expect(scene()).toBe("songBrowser");
    act(() => {
      search.blur();
    });
    key("H");
    expect(scene()).toBe("lineUp");
    // The Queue overlay is on top: H is the scene's key, not the overlay's.
    key("q");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Queue");
    key("h");
    expect(scene()).toBe("lineUp");
  });

  it("offers nothing on the song browser of an empty Queue", () => {
    const { scene } = setup(party());
    expect(browsePill()).toBeNull();
    expect(banner()).toBeNull();
    key("h");
    expect(scene()).toBe("songBrowser");
  });

  it("stays on the song browser while the same head's Line-up changes", () => {
    const { scene, changeParty } = setup(waiting());
    key("h");
    // A Phone adds a Request and edits the Line-up: the head is the same.
    changeParty(waiting(1, [request(1), request(2), request(3)]));
    expect(scene()).toBe("songBrowser");
  });

  it("brings the Line-up back once the head is a different Request", () => {
    const { scene, changeParty } = setup(waiting());
    key("h");
    // A Phone removed the head, or played another Request next.
    changeParty(waiting(2, [request(2)]));
    expect(scene()).toBe("lineUp");
    // Back on the Line-up, the old head is no longer set aside.
    changeParty(waiting(1, [request(1), request(2)]));
    expect(scene()).toBe("lineUp");
  });

  it("ends once the head's Song starts", () => {
    const { scene, changeParty } = setup(waiting());
    key("h");
    changeParty(
      party({
        queue: [request(1)],
        head: 1,
        playing: { requestId: 1, songId: 1, paused: false },
      }),
    );
    expect(scene()).toBe("sing");
    changeParty(waiting());
    expect(scene()).toBe("lineUp");
  });
});
