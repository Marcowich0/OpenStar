import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serverInfoQuery, songQuery, songsQuery } from "../../../api/queries";
import { createQueryClient } from "../../../api/queryClient";
import type { ClientMessage } from "../../../generated/ClientMessage";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { SongDetail } from "../../../generated/SongDetail";
import type { SongSummary } from "../../../generated/SongSummary";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import type { PreviewSong } from "../../../playback/songPreview";
import { StageFrame } from "../../frame/StageFrame";

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
  vi.clearAllMocks();
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
  const songList = (list: SongSummary[]) => ({
    songs: list,
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
  if (songs) queries.setQueryData(songsQuery().queryKey, songList(songs));
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
  return { sent, changeParty, reject, songsArrive, avSync, ...view };
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
