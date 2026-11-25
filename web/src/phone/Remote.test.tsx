import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import type { ClientMessage } from "../generated/ClientMessage";
import type { PartyEvent } from "../generated/PartyEvent";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import type { Request } from "../generated/Request";
import type { ServerMessage } from "../generated/ServerMessage";
import type { SongFilters } from "../generated/SongFilters";
import type { SongSummary } from "../generated/SongSummary";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { Remote } from "./Remote";

const PROFILES: Profile[] = [
  {
    id: 7,
    name: "Bo",
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
  },
  {
    id: 8,
    name: "Jonas",
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "sky",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
  },
];

/** The Song details the strip reads: only the fields it uses. */
const SONGS: Record<number, unknown> = {
  40: {
    id: 40,
    song: {
      headers: { title: "Valerie", artist: "Amy Winehouse", year: 2006 },
      voices: [{ lines: [] }],
    },
    lengthSeconds: 200,
    preparing: false,
    media: { cover: null, background: null, tileColour: "teal" },
  },
};

const request = (requestId: number, songId: number): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

/** Bo (member 1) uses this Phone; Jonas (member 2) another. */
const idle: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "cherry",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
    {
      memberId: 2,
      identity: { kind: "profile", profileId: 8 },
      colour: "sky",
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
};

const waiting: PartySnapshot = {
  ...idle,
  queue: [request(1, 40), request(2, 41), request(3, 42)],
  head: 1,
  lineUp: {
    requestId: 1,
    duet: false,
    seats: [],
    canStart: false,
    warnings: [],
  },
};

const summary = (
  id: number,
  title: string,
  artist: string,
  more: Partial<SongSummary> = {},
): SongSummary => ({
  id,
  path: `${artist} - ${title}/song.txt`,
  artist,
  title,
  duet: false,
  identity: { kind: "artistTitle", artist, title, duet: false },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
  ...more,
});

/** The Library's listed Songs, by artist, then title. */
const LIBRARY: SongSummary[] = [
  summary(41, "Islands", "The xx", { duet: true, year: 2009 }),
  summary(40, "Valerie", "Amy Winehouse", {
    year: 2006,
    topHighScore: {
      holder: {
        profileId: 7,
        name: "Bo",
        avatar: { kind: "builtIn", key: "cat" },
        favouriteColour: "cherry",
      },
      total: 8120,
    },
  }),
  summary(42, "Africa", "Toto", { year: 1982, preparing: true }),
];

const FILTERS: SongFilters = {
  languages: ["English"],
  genres: ["Pop", "Rock"],
  years: [1982, 2006, 2009],
  editions: [],
  creators: [],
  duet: [false, true],
  hasVideo: [false],
  length: { minSeconds: 200, maxSeconds: 200 },
};

/** Each `GET /api/songs` the Phone made, as its URL query. */
let songLists: URLSearchParams[] = [];

beforeEach(() => {
  songLists = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(input, "http://openstar.test");
      const path = url.pathname;
      if (path === "/api/songs") {
        songLists.push(url.searchParams);
        const search = url.searchParams.get("search")?.toLowerCase() ?? "";
        const songs = LIBRARY.filter((s) =>
          `${s.artist} ${s.title}`.toLowerCase().includes(search),
        );
        return Promise.resolve(Response.json({ songs, filters: FILTERS }));
      }
      if (/^\/api\/songs\/\d+\/high-scores$/.test(path))
        return Promise.resolve(Response.json({ tables: [] }));
      const song = /^\/api\/songs\/(\d+)$/.exec(path);
      if (song) return Promise.resolve(Response.json(SONGS[Number(song[1])]));
      return Promise.resolve(Response.json(PROFILES));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The Remote of a Phone already in the Party as Bo. */
function renderRemote(snapshot: PartySnapshot) {
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
  const server = (...messages: ServerMessage[]) => {
    act(() => {
      for (const message of messages) handlers?.onMessage(message);
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  server(
    { type: "liveState", stageId: "main", party: snapshot, isStage: false },
    { type: "phoneStatus", memberId: 1 },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Remote store={store} />
    </QueryClientProvider>,
  );
  /** Another Remote, the Stage or this Phone changed the Party. */
  const change = (
    actor: { kind: "stage" } | { kind: "member"; memberId: number },
    event: PartyEvent,
    party: PartySnapshot = snapshot,
  ) => {
    server({ type: "partyChanged", party, change: { actor, event } });
  };
  return { sent, server, change };
}

const selected = () =>
  screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-key");

describe("the Remote frame", () => {
  it("opens on Songs while no Line-up waits", () => {
    renderRemote(idle);
    expect(screen.getByRole("tab", { name: "Songs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens on the Stage tab while a Line-up waits", () => {
    renderRemote(waiting);
    expect(screen.getByRole("tab", { name: /Stage/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("counts the Requests in the Queue tab's badge", () => {
    const { change } = renderRemote(idle);
    expect(screen.getByRole("tab", { name: "Queue" })).toBeInTheDocument();

    change(
      { kind: "stage" },
      {
        code: "requestAdded",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
      waiting,
    );
    const queue = screen.getByRole("tab", { name: "Queue, 3 Requests" });
    expect(within(queue).getByText("3")).toBeInTheDocument();
  });

  it("shows the waiting Line-up in the strip, off the Stage tab, and opens the Stage tab on a tap", async () => {
    renderRemote(waiting);
    // It opened on the Stage tab, where the strip is never shown.
    expect(screen.queryByText("Waiting for Start")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Songs" }));
    const strip = await screen.findByRole("button", {
      name: /Line-up for Valerie/,
    });
    expect(within(strip).getByText("Waiting for Start")).toBeInTheDocument();

    fireEvent.click(strip);
    expect(screen.getByRole("tab", { name: /Stage/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByText("Waiting for Start")).toBeNull();
  });

  it("hides the strip while no Line-up waits", () => {
    renderRemote(idle);
    expect(screen.queryByText("Waiting for Start")).toBeNull();
    expect(screen.queryByRole("button", { name: /Line-up/ })).toBeNull();
  });

  it("offers no guarded action: only the tabs, the Songs tab, and the strip to the Stage tab", async () => {
    const { sent } = renderRemote(waiting);
    fireEvent.click(screen.getByRole("tab", { name: "Songs" }));
    await screen.findByRole("button", { name: /Line-up for Valerie/ });
    // Only the selected tab's panel is rendered.
    const songs = screen.getByRole("tabpanel");
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => !songs.contains(button))
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("Line-up for Valerie")]);
    expect(sent).toEqual([]);
    expect(selected()).toBe("songs");
  });
});

describe("the Songs tab", () => {
  const songList = () => screen.getByRole("list", { name: "Songs" });
  const row = (title: string) =>
    within(songList())
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText(title) !== null);

  it("has a search box, filter chips and the Library's Songs", async () => {
    renderRemote(idle);
    expect(
      screen.getByRole("searchbox", { name: "Search songs or artists" }),
    ).toBeInTheDocument();
    await screen.findByText("Valerie");
    const chips = screen.getByRole("group", { name: "Filters" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual([
      "All",
      "Duets",
      "English",
      "Pop",
      "Rock",
      "2009",
      "2006",
      "1982",
    ]);
    expect(within(chips).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(songList())
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/Islands.*The xx.*Duet.*2009/),
      expect.stringMatching(/Valerie.*Amy Winehouse.*2006.*Best 8,120/),
      expect.stringMatching(/Africa.*Toto.*Preparing.*1982/),
    ]);
    const valerie = row("Valerie");
    expect(valerie && within(valerie).getByTestId("cover")).toBeInTheDocument();
    expect(
      valerie && within(valerie).getByRole("button", { name: "Add Valerie" }),
    ).toBeInTheDocument();
  });

  it("searches by song or artist", async () => {
    renderRemote(idle);
    await screen.findByText("Valerie");
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search songs or artists" }),
      { target: { value: "amy" } },
    );
    await waitFor(() => {
      expect(within(songList()).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(songList()).toHaveTextContent("Valerie");
    expect(songLists.at(-1)?.get("search")).toBe("amy");
  });

  it("filters with a chip, and All turns the filters off", async () => {
    renderRemote(idle);
    await screen.findByText("Valerie");
    const chips = screen.getByRole("group", { name: "Filters" });
    fireEvent.click(within(chips).getByRole("button", { name: "Duets" }));
    await waitFor(() => {
      expect(songLists.at(-1)?.get("duet")).toBe("true");
    });
    expect(
      within(chips).getByRole("button", { name: "Duets" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(chips).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(within(chips).getByRole("button", { name: "Pop" }));
    await waitFor(() => {
      expect(songLists.at(-1)?.get("genre")).toBe("Pop");
    });
    expect(songLists.at(-1)?.get("duet")).toBe("true");

    fireEvent.click(within(chips).getByRole("button", { name: "All" }));
    expect(within(chips).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(chips).getByRole("button", { name: "Pop" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Back to the first list, which is still cached.
    expect(songLists[0]?.toString()).toBe("");
  });

  it("opens the Request sheet from a row or its + button, and closes it on a tap outside", async () => {
    renderRemote(idle);
    fireEvent.click(await screen.findByRole("button", { name: "Add Valerie" }));
    expect(
      await screen.findByRole("dialog", { name: "Valerie" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Add to the Queue" }),
    ).toBeInTheDocument();

    const veil = screen.getByTestId("sheet-veil");
    fireEvent.pointerDown(veil);
    fireEvent.click(veil);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Valerie/ }));
    expect(
      await screen.findByRole("dialog", { name: "Valerie" }),
    ).toBeInTheDocument();
  });
});

describe("the Remote's toasts", () => {
  it("show another Remote's change with its avatar, at the top", async () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "member", memberId: 2 },
      {
        code: "requestMovedUp",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    const toast = await within(toasts).findByText(
      (_, element) =>
        element?.tagName === "LI" &&
        element.textContent === "Jonas moved Valerie up",
    );
    expect(within(toast).getByText("Valerie").tagName).toBe("B");
    // The name is in the text; the avatar beside it is not read twice.
    expect(
      within(toast).getByRole("img", { name: "Jonas", hidden: true }),
    ).toBeInTheDocument();
  });

  it("show the Stage's changes too", () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "stage" },
      {
        code: "requestRemoved",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("Valerie was removed from the Queue");
  });

  it("say “you” for this Phone's own changes", () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "member", memberId: 1 },
      {
        code: "requestMovedUp",
        params: { requestId: 1, songId: 41, title: "Africa" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("You moved Africa up");
  });

  it("go away after a few seconds", () => {
    vi.useFakeTimers();
    const { change } = renderRemote(idle);
    change(
      { kind: "stage" },
      {
        code: "requestRemoved",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("Valerie");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(toasts).toBeEmptyDOMElement();
  });
});
