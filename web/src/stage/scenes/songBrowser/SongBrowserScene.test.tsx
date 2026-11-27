import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  serverInfoQuery,
  songHighScoresQuery,
  songQuery,
  songsQuery,
} from "../../../api/queries";
import { createQueryClient } from "../../../api/queryClient";
import type { ClientMessage } from "../../../generated/ClientMessage";
import type { HighScoreHolder } from "../../../generated/HighScoreHolder";
import type { HighScoreTable } from "../../../generated/HighScoreTable";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { SongDetail } from "../../../generated/SongDetail";
import type { SongFilters } from "../../../generated/SongFilters";
import type { SongQuery } from "../../../generated/SongQuery";
import type { SongSummary } from "../../../generated/SongSummary";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import type { PreviewSong } from "../../../playback/songPreview";
import { StageFrame } from "../../frame/StageFrame";
import { JOIN_CARD_HIDDEN_KEY } from "../../joinCard/JoinCard";
import { JOIN_LANE_PX } from "../SongBrowserScene";

// The preview plays through the Stage's AudioContext, which jsdom lacks.
const preview = vi.hoisted(() => ({
  play: vi.fn<(song: PreviewSong | null) => void>(),
  stop: vi.fn<() => void>(),
}));
// Check A/V sync clicks on the Stage's AudioContext, which jsdom lacks too.
vi.mock("../../playback/stageAudio", async () =>
  (await import("../../../avSync/fakeStageAudio")).fakeStageAudioModule(),
);
vi.mock("../../playback/stagePreview", () => ({
  stagePreview: () => preview,
}));

beforeEach(() => {
  // Song details not set up front never arrive.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const song = (
  id: number,
  title: string,
  over: Partial<SongSummary> = {},
): SongSummary => ({
  id,
  path: `${title}.txt`,
  artist: `${title} Band`,
  title,
  duet: false,
  identity: { kind: "artistTitle", artist: "x", title, duet: false },
  lengthSeconds: 233.4,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
  ...over,
});

const detail = (
  id: number,
  over: { genre?: string | null; native?: boolean } = {},
): SongDetail =>
  ({
    id,
    lengthSeconds: 200,
    preparing: false,
    loudnessLufs: null,
    song: {
      headers: { genre: over.genre ?? null, previewStartSeconds: 30 },
    },
    media: {
      audio: {
        url: `/api/songs/${String(id)}/media/audio`,
        native: over.native ?? true,
      },
    },
  }) as unknown as SongDetail;

const SONGS = [
  song(1, "Africa", {
    duet: true,
    year: 1982,
    topHighScore: {
      total: 9480,
      holder: {
        profileId: 4,
        name: "Sofie",
        avatar: { kind: "builtIn", key: "cat" },
        favouriteColour: "sky",
      },
    },
  }),
  song(2, "Islands"),
  song(3, "Moon"),
  song(4, "Wave"),
];

const FILTERS: SongFilters = {
  languages: ["English"],
  genres: ["Pop"],
  years: [1982, 1999],
  editions: [],
  creators: [],
  duet: [false, true],
  hasVideo: [false],
  length: null,
};

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

function setup(
  songs: SongSummary[] | null = SONGS,
  details: SongDetail[] = [detail(1, { genre: "Pop" })],
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
  const queries = createQueryClient();
  const songList = (list: SongSummary[]) => ({ songs: list, filters: FILTERS });
  if (songs) queries.setQueryData(songsQuery().queryKey, songList(songs));
  // What `GET /api/songs` answers for a search or filter.
  const answer = (query: SongQuery, list: SongSummary[]) => {
    queries.setQueryData(songsQuery(query).queryKey, songList(list));
  };
  const highScores = (id: number, tables: HighScoreTable[]) => {
    queries.setQueryData(songHighScoresQuery(id).queryKey, { tables });
  };
  const songsArrive = (list: SongSummary[]) => {
    act(() => {
      queries.setQueryData(songsQuery().queryKey, songList(list));
    });
  };
  for (const d of details) queries.setQueryData(songQuery(d.id).queryKey, d);
  queries.setQueryData(serverInfoQuery.queryKey, {
    version: "dev",
    schemaVersion: 1,
    libraryReadOnly: null,
    publicUrl: "https://openstar.example.org",
  });
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  const view = render(
    <QueryClientProvider client={queries}>
      <StageFrame store={store} />
    </QueryClientProvider>,
  );
  live((h) => {
    h.onConnection("open");
    h.onMessage({
      type: "liveState",
      stageId: "main",
      party: party(),
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
          event: {
            code: "requestAdded",
            params: { requestId: 1, songId: 1, title: "Africa" },
          },
        },
      });
    });
  };
  const reject = (code: "songPreparing") => {
    live((h) => {
      h.onMessage({ type: "rejected", reason: { code } });
    });
  };
  const avSync = (running: boolean) => {
    live((h) => {
      h.onMessage({ type: "avSync", running });
    });
  };
  const calibration = (open: boolean) => {
    live((h) => {
      h.onMessage({
        type: "calibration",
        run: open ? { phase: "choosing", mics: [] } : null,
      });
    });
  };
  return {
    sent,
    answer,
    highScores,
    changeParty,
    reject,
    songsArrive,
    avSync,
    calibration,
    ...view,
  };
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

function click(element: Element) {
  act(() => {
    fireEvent.click(element);
  });
}

const title = () => screen.getByRole("heading", { level: 1 });
const info = () => screen.getByTestId("song-info");
const sing = () => screen.getByRole("button", { name: "Sing!" });
const selectedCover = () => screen.getByTestId("carousel-selected");
const adds = (sent: ClientMessage[]) =>
  sent.filter((m) => m.type === "addRequest");

describe("the song browser", () => {
  it("is the resting scene: logo, the selected Song and Sing!, no Up next card", () => {
    const { container } = setup();
    expect(
      container.querySelector("[data-stage-frame]")?.getAttribute("data-scene"),
    ).toBe("songBrowser");
    expect(screen.getByTestId("stage-logo")).toHaveTextContent("OpenStar");
    expect(title()).toHaveTextContent("Africa");
    expect(within(info()).getByText("Africa Band")).toBeVisible();
    expect(sing()).toBeVisible();
    expect(screen.queryByText(/up next/i)).toBeNull();
    // The join card (#178) keeps the Join code.
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("4821");
  });

  it("shows the join card with the QR code for the public address", () => {
    setup();
    expect(
      screen.getByRole("img", { name: "QR code to join the Party" }),
    ).toHaveAttribute(
      "data-qr-text",
      "https://openstar.example.org/?join=4821",
    );
    expect(screen.getByText("Pick a song from your phone")).toBeVisible();
  });

  it("shows a new Join code on the card at once", () => {
    const { changeParty } = setup();
    changeParty(party({ joinCode: "0427" }));
    expect(screen.getByTestId("party-join-code")).toHaveTextContent("0427");
    expect(
      screen.getByRole("img", { name: "QR code to join the Party" }),
    ).toHaveAttribute(
      "data-qr-text",
      "https://openstar.example.org/?join=0427",
    );
  });

  it("keeps the carousel out of the join card's lane until the card hides", () => {
    // Africa selected: Islands one step right, Moon two, Wave one left.
    setup();
    const room = screen.getByTestId("song-browser-room");
    const moon = () => screen.getByTestId("carousel-cover-3");
    const islands = screen.getByTestId("carousel-cover-2");
    const wave = screen.getByTestId("carousel-cover-4");
    try {
      expect(room.style.right).toBe(`${String(JOIN_LANE_PX)}px`);
      expect(islands.style.opacity).toBe("1");
      expect(wave.style.opacity).toBe("1");
      // Two steps right would reach under the QR code.
      expect(moon().style.opacity).toBe("0");

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      });
      expect(room.style.right).toBe("0px");
      expect(moon().style.opacity).toBe("1");
    } finally {
      window.localStorage.removeItem(JOIN_CARD_HIDDEN_KEY);
    }
  });

  it("starts with the focus on the selected cover", () => {
    setup();
    expect(document.activeElement).toBe(selectedCover());
  });

  it("takes the focus when the Songs arrive after the scene started", async () => {
    const { songsArrive } = setup(null);
    expect(screen.queryByTestId("carousel-selected")).toBeNull();
    songsArrive(SONGS);
    expect(await screen.findByTestId("carousel-selected")).toBe(
      document.activeElement,
    );
  });

  it("leaves the focus in an open overlay when the Songs arrive", async () => {
    const { songsArrive } = setup(null);
    press("q");
    const queue = screen.getByRole("dialog", { name: "Queue" });
    songsArrive(SONGS);
    await screen.findByTestId("carousel-selected");
    expect(queue).toContainElement(document.activeElement as HTMLElement);
  });

  it("shows Duet, genre, year, length and the best score as chips", () => {
    setup();
    const chips = within(info()).getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Duet",
      "Pop",
      "1982",
      "3:53",
      "Best 9,480 · Sofie",
    ]);
  });

  it("leaves out the chips a Song has nothing for", () => {
    setup();
    press("ArrowRight");
    const chips = within(info()).getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["3:53"]);
  });

  it("steps the selected Song with ← and →, wrapping round", () => {
    setup();
    press("ArrowRight");
    expect(title()).toHaveTextContent("Islands");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(title()).toHaveTextContent("Wave");
    // The focus stays on the (new) selected cover.
    expect(document.activeElement).toBe(selectedCover());
    expect(selectedCover()).toHaveAttribute("data-song-id", "4");
  });

  it("steps once per → however quickly the presses come, and Enter picks the Song shown", async () => {
    const { sent } = setup();
    // As in a browser: no act() around the presses, so React renders and
    // runs its effects on its own schedule between them.
    const env = globalThis as {
      IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
    };
    const before = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const key = (k: string) =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
    try {
      key("ArrowRight");
      key("ArrowRight");
      key("Enter");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = before;
    }
    expect(title()).toHaveTextContent("Moon");
    expect(adds(sent)).toEqual([
      { type: "addRequest", songId: 3, requestedPlayers: null },
    ]);
  });

  it("selects a neighbour on a click", () => {
    setup();
    click(screen.getByTestId("carousel-cover-3"));
    expect(title()).toHaveTextContent("Moon");
  });

  it("places the covers with the carousel geometry", () => {
    setup();
    // jsdom writes translate(0px, 0px) as translate(0px).
    expect(screen.getByTestId("carousel-cover-1").style.transform).toBe(
      "translate(0px) scale(1.22) rotate(0deg)",
    );
    expect(screen.getByTestId("carousel-cover-2").style.transform).toBe(
      "translate(390px, 26px) scale(0.74) rotate(5deg)",
    );
    // Four Songs: the last sits left of the first.
    expect(screen.getByTestId("carousel-cover-4").style.transform).toBe(
      "translate(-390px, 26px) scale(0.74) rotate(-5deg)",
    );
  });

  it("squashes the selected cover and pops the Song info in on a change", () => {
    setup();
    press("ArrowRight");
    expect(
      within(selectedCover()).getByTestId("cover").parentElement,
    ).toHaveClass("motion-safe:animate-squish");
    expect(info()).toHaveClass("animate-pop-in");
  });

  it("says so when the Library has no Songs", () => {
    setup([], []);
    expect(screen.getByText("No Songs in the Library yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sing!" })).toBeNull();
  });
});

describe("Sing!", () => {
  it("adds the selected Song as a Request from the Stage, naming no Players", () => {
    const { sent } = setup();
    press("ArrowRight");
    click(sing());
    expect(adds(sent)).toEqual([
      { type: "addRequest", songId: 2, requestedPlayers: null },
    ]);
  });

  it("is also Enter on the selected cover", () => {
    const { sent } = setup();
    press("Enter");
    expect(adds(sent)).toEqual([
      { type: "addRequest", songId: 1, requestedPlayers: null },
    ]);
  });

  it("adds once while the server has not answered", () => {
    const { sent } = setup();
    click(sing());
    click(sing());
    expect(adds(sent)).toHaveLength(1);
  });

  it("shows the Line-up once the Request heads the Queue, with no toast", () => {
    const { sent, changeParty, container } = setup();
    click(sing());
    expect(adds(sent)).toHaveLength(1);
    changeParty(
      party({
        queue: [
          {
            requestId: 1,
            kind: "song",
            songId: 1,
            requestedPlayers: [],
            adder: null,
          },
        ],
        head: 1,
      }),
    );
    expect(
      container.querySelector("[data-stage-frame]")?.getAttribute("data-scene"),
    ).toBe("lineUp");
    expect(screen.queryByText(/added/i)).toBeNull();
  });

  it("shows the server's refusal", async () => {
    const { reject } = setup();
    click(sing());
    reject("songPreparing");
    expect(
      await screen.findByText(
        "That Song is still being prepared. Try again in a moment",
      ),
    ).toBeVisible();
  });
});

describe("a Song still preparing", () => {
  const preparing = [
    song(1, "Africa", { preparing: true }),
    song(2, "Islands"),
  ];

  it("shows 'Preparing' on its cover and cannot be added: Sing! is disabled and shakes", () => {
    const { sent } = setup(preparing);
    expect(within(selectedCover()).getByText("Preparing")).toBeVisible();
    expect(sing()).toHaveAttribute("aria-disabled", "true");
    click(sing());
    expect(sing()).toHaveAttribute("data-shaking");
    press("Enter");
    expect(adds(sent)).toEqual([]);
  });
});

describe("the preview", () => {
  it("plays the selected Song's preview", () => {
    setup();
    expect(preview.play).toHaveBeenLastCalledWith({
      id: 1,
      url: "/api/songs/1/media/audio",
      startSeconds: 30,
      loudnessLufs: null,
    });
  });

  it("stops when the selection changes before the next Song's detail is in", () => {
    setup();
    press("ArrowRight");
    expect(preview.play).toHaveBeenLastCalledWith(null);
  });

  it("plays the next Song once selected", () => {
    setup(SONGS, [detail(1), detail(2)]);
    press("ArrowRight");
    expect(preview.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 2 }),
    );
  });

  it("stops while Check A/V sync runs, and plays again once it ends", () => {
    const { avSync } = setup();
    avSync(true);
    expect(preview.play).toHaveBeenLastCalledWith(null);
    avSync(false);
    expect(preview.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("stops from the Calibrate mics checklist until the run ends or is cancelled", () => {
    const { calibration } = setup();
    calibration(true);
    expect(preview.play).toHaveBeenLastCalledWith(null);
    calibration(false);
    expect(preview.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("stops when the song browser closes", () => {
    const { changeParty } = setup();
    changeParty(
      party({
        queue: [
          {
            requestId: 1,
            kind: "song",
            songId: 1,
            requestedPlayers: [],
            adder: null,
          },
        ],
        head: 1,
      }),
    );
    expect(preview.stop).toHaveBeenCalled();
  });
});

describe("muting the preview", () => {
  const mute = () => screen.getByRole("button", { name: "Mute preview" });

  it("is a toggle beside Search, off at first", () => {
    setup();
    expect(mute()).toHaveAttribute("aria-pressed", "false");
    expect(mute()).toHaveAttribute("aria-keyshortcuts", "M");
    expect(mute().parentElement).toBe(
      screen.getByRole("button", { name: "Search" }).parentElement,
    );
  });

  it("stops the preview on a click, and plays the selected Song again on the next", () => {
    setup();
    click(mute());
    expect(mute()).toHaveAttribute("aria-pressed", "true");
    expect(preview.play).toHaveBeenLastCalledWith(null);
    click(mute());
    expect(mute()).toHaveAttribute("aria-pressed", "false");
    expect(preview.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("toggles on M, either case", () => {
    setup();
    press("m");
    expect(mute()).toHaveAttribute("aria-pressed", "true");
    expect(preview.play).toHaveBeenLastCalledWith(null);
    press("M");
    expect(mute()).toHaveAttribute("aria-pressed", "false");
  });

  it("plays nothing while muted, whatever is selected", () => {
    setup(SONGS, [detail(1), detail(2)]);
    press("m");
    press("ArrowRight");
    expect(title()).toHaveTextContent("Islands");
    expect(preview.play).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
  });

  it("is remembered by this browser", () => {
    const { unmount } = setup();
    press("m");
    expect(window.localStorage.getItem("openstar.previewMuted")).toBe("true");
    unmount();
    setup();
    expect(mute()).toHaveAttribute("aria-pressed", "true");
  });

  it("starts muted when this browser chose so, and never plays", () => {
    window.localStorage.setItem("openstar.previewMuted", "true");
    setup();
    expect(mute()).toHaveAttribute("aria-pressed", "true");
    expect(preview.play).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("still works when the browser's storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setup();
    expect(mute()).toHaveAttribute("aria-pressed", "false");
    click(mute());
    expect(mute()).toHaveAttribute("aria-pressed", "true");
    expect(preview.play).toHaveBeenLastCalledWith(null);
  });

  it("stays muted once Check A/V sync ends", () => {
    const { avSync } = setup();
    press("m");
    avSync(true);
    avSync(false);
    expect(preview.play).toHaveBeenLastCalledWith(null);
    expect(preview.play).toHaveBeenCalledTimes(2);
  });
});

describe("search", () => {
  const box = () =>
    screen.getByRole("searchbox", { name: "Search songs or artists" });
  const filters = () => screen.getByRole("group", { name: "Filters" });
  const type = (text: string) => {
    act(() => {
      fireEvent.change(box(), { target: { value: text } });
    });
  };

  it("opens on / with the box focused and the Songs tab's filter chips", () => {
    setup();
    expect(screen.queryByRole("searchbox")).toBeNull();
    press("/");
    expect(document.activeElement).toBe(box());
    expect(
      within(filters())
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["All", "Duets", "English", "Pop", "1999", "1982"]);
  });

  it("narrows the carousel to the matching Songs as you type", () => {
    const { answer } = setup();
    answer({ search: "isl" }, [SONGS[1] as SongSummary]);
    press("/");
    type("isl");
    expect(title()).toHaveTextContent("Islands");
    expect(screen.queryByTestId("carousel-cover-1")).toBeNull();
  });

  it("narrows by a filter chip, and All clears it", () => {
    const { answer } = setup();
    answer({ duet: true }, [SONGS[0] as SongSummary]);
    press("/");
    const duets = within(filters()).getByRole("button", { name: "Duets" });
    click(duets);
    expect(duets).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("carousel-cover-2")).toBeNull();
    click(within(filters()).getByRole("button", { name: "All" }));
    expect(screen.getByTestId("carousel-cover-2")).toBeInTheDocument();
  });

  it("replaces the carousel with a short message when nothing matches", () => {
    const { answer } = setup();
    answer({ search: "zzz" }, []);
    press("/");
    type("zzz");
    expect(screen.getByText("No Songs match")).toBeVisible();
    expect(screen.queryByTestId("carousel-selected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sing!" })).toBeNull();
  });

  it("moves the focus down from the box to the chips, then to the carousel", () => {
    setup();
    press("/");
    press("ArrowDown");
    expect(document.activeElement).toBe(
      within(filters()).getByRole("button", { name: "All" }),
    );
    press("ArrowDown");
    expect(document.activeElement).toBe(selectedCover());
  });

  it("lets / be typed into the box", () => {
    setup();
    press("/");
    press("/");
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(document.activeElement).toBe(box());
  });

  it("clears the search and closes the box on Esc", () => {
    const { answer } = setup();
    answer({ search: "isl" }, [SONGS[1] as SongSummary]);
    press("/");
    type("isl");
    press("Escape");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByTestId("carousel-cover-1")).toBeInTheDocument();
    // The Song found stays selected.
    expect(title()).toHaveTextContent("Islands");
    expect(document.activeElement).toBe(selectedCover());
    // Opened again, it starts empty.
    press("/");
    expect(box()).toHaveValue("");
  });

  it.each(["BrowserBack", "GoBack", "Backspace"])(
    "closes the box with a TV remote's Back (%s) from the carousel",
    (back) => {
      setup();
      press("/");
      press("Enter");
      expect(document.activeElement).toBe(selectedCover());
      press(back);
      expect(screen.queryByRole("searchbox")).toBeNull();
    },
  );

  it("leaves Backspace in the box to the box, which stays open", () => {
    setup();
    press("/");
    type("isl");
    let notPrevented = false;
    act(() => {
      notPrevented = fireEvent.keyDown(box(), { key: "Backspace" });
    });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(box());
    expect(box()).toHaveValue("isl");
  });

  it("narrows the Songs overlay's carousel too", () => {
    const { answer } = setup();
    answer({ search: "isl" }, [SONGS[1] as SongSummary]);
    press("/");
    type("isl");
    press("ArrowDown");
    press("s");
    const songs = screen.getByRole("dialog", { name: "Songs" });
    expect(within(songs).getByTestId("carousel-selected")).toHaveAccessibleName(
      "Islands",
    );
    expect(within(songs).queryByTestId("carousel-cover-1")).toBeNull();
  });

  it("keeps the focus in the box when the Songs arrive after it opened", async () => {
    const { songsArrive } = setup(null);
    press("/");
    songsArrive(SONGS);
    await screen.findByTestId("carousel-selected");
    expect(document.activeElement).toBe(box());
  });

  it("opens from the Search button, with the focus in the box", () => {
    setup();
    const open = screen.getByRole("button", { name: "Search" });
    expect(open).toHaveAttribute("aria-keyshortcuts", "/");
    click(open);
    expect(document.activeElement).toBe(box());
    // The box stands where the button was.
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    press("Escape");
    expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
  });

  it("takes s, q, p and m typed into the box as text, not as Stage keys", () => {
    setup();
    press("/");
    for (const key of ["s", "q", "p", "m", "S", "M"]) press(key);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Mute preview" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(document.activeElement).toBe(box());
  });

  it("moves to the Song found on Enter, and a second Enter sings it", () => {
    const { answer, sent } = setup();
    answer({ search: "isl" }, [SONGS[1] as SongSummary]);
    press("/");
    type("isl");
    press("Enter");
    expect(document.activeElement).toBe(selectedCover());
    expect(adds(sent)).toHaveLength(0);
    press("Enter");
    expect(adds(sent).at(-1)).toMatchObject({ songId: 2 });
  });

  it("selects a neighbour on a click while the box is open", () => {
    setup();
    press("/");
    click(screen.getByTestId("carousel-cover-2"));
    expect(title()).toHaveTextContent("Islands");
    expect(box()).toBeInTheDocument();
  });

  it("keeps the focus in the box while the mouse passes over a cover", () => {
    setup();
    press("/");
    act(() => {
      fireEvent.pointerOver(selectedCover());
    });
    expect(document.activeElement).toBe(box());
  });
});

describe("the Song detail", () => {
  const holder = (
    profileId: number,
    name: string,
    favouriteColour: HighScoreHolder["favouriteColour"],
  ): HighScoreHolder => ({
    profileId,
    name,
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour,
  });
  const table = (
    voice: number,
    difficulty: HighScoreTable["difficulty"],
    entries: HighScoreTable["entries"],
  ): HighScoreTable => ({ voice, difficulty, entries });
  const TABLES: HighScoreTable[] = [
    table(0, "easy", []),
    table(0, "medium", [
      {
        place: 1,
        holder: holder(4, "Sofie", "sky"),
        total: 9480,
        olderTiming: false,
      },
      {
        place: 2,
        holder: holder(5, "Jonas", "cherry"),
        total: 7120,
        olderTiming: true,
      },
    ]),
    table(0, "hard", [
      {
        place: 1,
        holder: holder(5, "Jonas", "cherry"),
        total: 6010,
        olderTiming: false,
      },
    ]),
    table(1, "easy", []),
    table(1, "medium", [
      {
        place: 1,
        holder: holder(6, "Maja", "mint"),
        total: 8800,
        olderTiming: false,
      },
    ]),
    table(1, "hard", []),
  ];

  function openDetail() {
    const view = setup();
    view.highScores(1, TABLES);
    // As Enter does: the arrows put the focus on the chip, Enter clicks it.
    const best = screen.getByRole("button", { name: "Best 9,480 · Sofie" });
    act(() => {
      best.focus();
    });
    click(best);
    return view;
  }
  const detailDialog = () =>
    screen.getByRole("dialog", { name: "High scores" });
  const rows = () =>
    within(detailDialog())
      .getAllByRole("listitem")
      .map((row) => row.textContent);

  it("opens from the best-score chip with the Song and its Medium table", () => {
    openDetail();
    expect(within(detailDialog()).getByText("Africa")).toBeVisible();
    expect(
      within(detailDialog()).getByRole("tab", {
        name: "Medium",
        selected: true,
      }),
    ).toBeVisible();
    expect(rows()).toEqual(["1Sofie9,480", "2JonasOlder timing7,120"]);
  });

  it("shows the place, the avatar, the name in the favourite colour and the Score in tabular figures", () => {
    openDetail();
    const [first] = within(detailDialog()).getAllByRole("listitem");
    const row = within(first as HTMLElement);
    expect(row.getByRole("img", { name: "Sofie" })).toBeVisible();
    expect(row.getByText("Sofie").style.color).toBe("var(--color-party-sky)");
    expect(row.getByText("9,480")).toHaveClass("tabular-nums");
    expect(row.getByText("1")).toHaveClass("tabular-nums");
  });

  it("switches Difficulty and Voice with the tabs", () => {
    openDetail();
    click(within(detailDialog()).getByRole("tab", { name: "Hard" }));
    expect(rows()).toEqual(["1Jonas6,010"]);
    click(within(detailDialog()).getByRole("tab", { name: "Voice 2" }));
    click(within(detailDialog()).getByRole("tab", { name: "Medium" }));
    expect(rows()).toEqual(["1Maja8,800"]);
    click(within(detailDialog()).getByRole("tab", { name: "Easy" }));
    expect(
      within(detailDialog()).getByText("No High scores yet"),
    ).toBeVisible();
  });

  it("has no Voice tabs for a Song that is not a duet", () => {
    const solo = song(7, "Solo", {
      topHighScore: { total: 100, holder: holder(4, "Sofie", "sky") },
    });
    const { highScores } = setup([solo]);
    highScores(7, [
      table(0, "easy", []),
      table(0, "medium", []),
      table(0, "hard", []),
    ]);
    click(screen.getByRole("button", { name: "Best 100 · Sofie" }));
    expect(
      within(detailDialog()).queryByRole("tab", { name: /Voice/ }),
    ).toBeNull();
    expect(within(detailDialog()).getAllByRole("tab")).toHaveLength(3);
  });

  it("closes on Esc, giving the focus back to the chip", () => {
    openDetail();
    press("Escape");
    expect(screen.queryByRole("dialog", { name: "High scores" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Best 9,480 · Sofie" }),
    );
  });
});
