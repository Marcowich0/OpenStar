import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../generated/PartySnapshot";
import type { SongList } from "../generated/SongList";
import type { SongSummary } from "../generated/SongSummary";
import type { LiveStore } from "../live/liveStore";
import { HOLD_DURATION_MS } from "../ui/hold";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Songs } from "./Songs";

function song(id: number, artist: string, title: string, cover: boolean) {
  return {
    id,
    path: `${artist} - ${title}/${artist} - ${title}.txt`,
    artist,
    title,
    duet: false,
    identity: { kind: "artistTitle", artist, title, duet: false },
    lengthSeconds: 180,
    hasVideo: false,
    preparing: false,
    cover: cover ? `/api/songs/${String(id)}/media/cover` : null,
    tileColour: "cherry",
    topHighScore: null,
    year: null,
  } satisfies SongSummary;
}

const SONGS = [
  song(1, "Abba", "Waterloo", true),
  song(2, "Queen", "Bohemian Rhapsody", false),
];

function songList(songs: SongSummary[]): SongList {
  return {
    songs,
    filters: {
      languages: [],
      genres: [],
      years: [],
      editions: [],
      creators: [],
      duet: [false],
      hasVideo: [false],
      length: null,
    },
  };
}

/** The Songs section inside a router, as on `/admin/songs` (its rows link). */
function SongsInRouter({ store }: { store?: LiveStore }) {
  const [router] = useState(() => {
    const root = createRootRoute({
      component: () => <Songs {...(store ? { store } : {})} />,
    });
    const timing = createRoute({
      getParentRoute: () => root,
      path: "/admin/songs/$song/timing",
    });
    return createRouter({
      routeTree: root.addChildren([timing]),
      history: createMemoryHistory(),
    });
  });
  return <RouterProvider router={router} />;
}

/** A browser whose `matchMedia` answers `full` for the full editor's query. */
function screenFor(full: boolean) {
  const queries: string[] = [];
  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query);
    return {
      matches: full,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
  return queries;
}

const list = () => screen.getByRole("list", { name: "Songs in the Library" });
const rows = () => within(list()).getAllByRole("listitem");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Songs section", () => {
  it("lists every playable Song with its cover, title and artist", async () => {
    fakeLibraryServer({ "GET /api/songs": songList(SONGS) });
    await renderLive(<SongsInRouter />);

    const [abba, queen] = rows();
    expect(abba).toHaveTextContent("Waterloo");
    expect(abba).toHaveTextContent("Abba");
    expect(abba?.querySelector("img")).toHaveAttribute(
      "src",
      "/api/songs/1/media/cover",
    );
    expect(queen).toHaveTextContent("Bohemian Rhapsody");
    expect(queen).toHaveTextContent("Queen");
  });

  it("searches artist and title on the server", async () => {
    const server = fakeLibraryServer({
      "GET /api/songs": (url: URL) =>
        songList(
          url.searchParams.get("search") === "queen" ? SONGS.slice(1) : SONGS,
        ),
    });
    await renderLive(<SongsInRouter />);

    act(() => {
      fireEvent.change(
        screen.getByRole("searchbox", { name: "Search by artist or title" }),
        { target: { value: "queen" } },
      );
    });
    await settle();

    expect(server.calls).toContain("GET /api/songs?search=queen");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Bohemian Rhapsody");
  });

  it("lists the trash below the Songs", async () => {
    fakeLibraryServer({
      "GET /api/songs": songList(SONGS),
      "GET /api/library/trash": {
        songs: [{ id: 4, originalPath: "Old - Song", deletedMs: 0 }],
      },
    });
    await renderLive(<SongsInRouter />);

    const trash = screen.getByRole("list", { name: "Songs in the trash" });
    expect(trash).toHaveTextContent("Old - Song");
    expect(
      within(trash).getByRole("button", { name: "Restore Old - Song" }),
    ).toBeVisible();
  });

  it("says when nothing matches and when the Library is empty", async () => {
    fakeLibraryServer({ "GET /api/songs": songList([]) });
    await renderLive(<SongsInRouter />);
    expect(
      screen.getByText("The Library has no playable Songs yet"),
    ).toBeVisible();

    act(() => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "zzz" },
      });
    });
    await settle();
    expect(screen.getByText("No Songs match")).toBeVisible();
  });

  it("links each Song to its Timing editor, with a fine pointer and room for it", async () => {
    const queries = screenFor(true);
    fakeLibraryServer({ "GET /api/songs": songList(SONGS) });
    await renderLive(<SongsInRouter />);

    expect(
      within(rows()[1] as HTMLElement).getByRole("link", {
        name: "Timing of Bohemian Rhapsody",
      }),
    ).toHaveAttribute("href", "/admin/songs/2/timing");
    expect(
      screen.queryByRole("button", { name: "Fit to the singing" }),
    ).toBeNull();
    expect(queries).toContain("(pointer: fine) and (min-width: 48rem)");
  });

  it("offers only Fit to the singing on a Phone or without a fine pointer", async () => {
    screenFor(false);
    fakeLibraryServer({ "GET /api/songs": songList(SONGS) });
    await renderLive(<SongsInRouter />);

    const row = within(rows()[1] as HTMLElement);
    expect(
      row.getByRole("button", { name: "Fit to the singing" }),
    ).toBeVisible();
    expect(row.queryByRole("link")).toBeNull();
    expect(row.queryByRole("button", { name: "offset only" })).toBeNull();
    expect(row.queryByText("Lines still off")).toBeNull();
  });

  it("refreshes on the Library change notice", async () => {
    let songs = SONGS;
    const server = fakeLibraryServer({
      "GET /api/songs": () => songList(songs),
    });
    const live = await renderLive(<SongsInRouter />);
    expect(rows()).toHaveLength(2);

    songs = [...SONGS, song(3, "Toto", "Africa", false)];
    await live.changed("library");

    expect(rows()).toHaveLength(3);
    expect(server.count("GET /api/songs")).toBe(2);
  });

  describe("Restore Original", () => {
    const restore = () =>
      screen.queryAllByRole("button", { name: "Restore Original" });
    const press = (button: HTMLElement | undefined) => {
      if (button === undefined) throw new Error("no Restore Original button");
      act(() => {
        fireEvent.click(button);
      });
    };
    const row = (n: number) => {
      const found = rows()[n];
      if (found === undefined) throw new Error(`no row ${String(n)}`);
      return found;
    };

    it("is offered only on a Song that has an Original", async () => {
      fakeLibraryServer({
        "GET /api/songs": songList(SONGS),
        "GET /api/library/originals": [2],
      });
      await renderLive(<SongsInRouter />);

      expect(
        within(row(0)).queryByRole("button", { name: "Restore Original" }),
      ).toBeNull();
      expect(
        within(row(1)).getByRole("button", { name: "Restore Original" }),
      ).toBeVisible();
    });

    it("restores the Original, and the button goes with the Library notice", async () => {
      let originals = [1];
      const server = fakeLibraryServer({
        "GET /api/songs": songList(SONGS),
        "GET /api/library/originals": () => originals,
        "GET /api/unlock": { unlocked: true },
        "POST /api/songs/1/restore-original": () => {
          originals = [];
          return "06c1e2f7";
        },
      });
      const live = await renderLive(<SongsInRouter />);

      press(restore()[0]);
      await settle();
      expect(server.count("POST /api/songs/1/restore-original")).toBe(1);

      await live.changed("library");
      expect(restore()).toHaveLength(0);
    });

    it("says why the server refused it", async () => {
      const answers: Record<string, unknown> = {
        "GET /api/server-info": {
          version: "dev",
          schemaVersion: 1,
          libraryReadOnly: null,
          publicUrl: null,
        },
        "GET /api/unlock": { unlocked: true },
        "GET /api/songs": songList(SONGS),
        "GET /api/library/originals": [1],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string, init: RequestInit) => {
          const route = `${init.method ?? "GET"} ${new URL(input, "http://test").pathname}`;
          const refused = route === "POST /api/songs/1/restore-original";
          return Promise.resolve(
            new Response(
              JSON.stringify(
                refused ? { code: "songPlaying" } : answers[route],
              ),
              {
                status: refused ? 409 : 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }),
      );
      await renderLive(<SongsInRouter />);

      press(restore()[0]);
      await settle();
      expect(within(row(0)).getByRole("alert")).toHaveTextContent(
        "This Song is playing on the Stage now",
      );
    });
  });

  describe("Delete", () => {
    const status = (code: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status: code,
        headers: { "Content-Type": "application/json" },
      });

    /** A Library whose guarded delete answers `answer` (a `204` that drops the Song by default). */
    function deleteServer(answer?: Response) {
      let songs = SONGS;
      const server = fakeLibraryServer({
        "GET /api/songs": () => songList(songs),
        "GET /api/unlock": { unlocked: true },
      });
      for (const s of SONGS)
        server.answers[`DELETE /api/songs/${String(s.id)}`] = () => {
          if (answer) return answer;
          songs = songs.filter((other) => other.id !== s.id);
          return status(204);
        };
      return server;
    }

    async function holdDelete(title: string, ms = HOLD_DURATION_MS) {
      vi.useFakeTimers();
      const button = screen.getByRole("button", { name: `Delete ${title}` });
      act(() => {
        fireEvent.pointerDown(button);
      });
      act(() => {
        vi.advanceTimersByTime(ms);
      });
      act(() => {
        fireEvent.pointerUp(button);
      });
      vi.useRealTimers();
      await settle();
    }

    it("does nothing on a short press", async () => {
      const server = deleteServer();
      await renderLive(<SongsInRouter />);

      await holdDelete("Waterloo", HOLD_DURATION_MS - 200);

      expect(server.count("DELETE /api/songs/1")).toBe(0);
    });

    it("deletes a Song after a press and hold; the Library notice drops its row", async () => {
      const server = deleteServer();
      const live = await renderLive(<SongsInRouter />);

      await holdDelete("Waterloo");
      expect(server.count("DELETE /api/songs/1")).toBe(1);
      await live.changed("library");

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toHaveTextContent("Bohemian Rhapsody");
    });

    it("says why when the folder holds another .txt, and keeps the Song", async () => {
      deleteServer(
        status(409, {
          code: "songFolderShared",
          params: { otherTxt: "Abba - Waterloo/other.txt" },
        }),
      );
      await renderLive(<SongsInRouter />);

      await holdDelete("Waterloo");

      const alert = within(rows()[0] as HTMLElement).getByRole("alert");
      expect(alert).toHaveTextContent(
        "Its folder also holds Abba - Waterloo/other.txt",
      );
      expect(rows()).toHaveLength(2);
    });

    it("says why when the .txt sits in the Library root", async () => {
      deleteServer(status(409, { code: "songInLibraryRoot" }));
      await renderLive(<SongsInRouter />);

      await holdDelete("Waterloo");

      expect(
        within(rows()[0] as HTMLElement).getByRole("alert"),
      ).toHaveTextContent("directly in the Library folder");
    });

    it("says why while the Song plays", async () => {
      deleteServer(status(409, { code: "songPlaying" }));
      await renderLive(<SongsInRouter />);

      await holdDelete("Waterloo");

      expect(
        within(rows()[0] as HTMLElement).getByRole("alert"),
      ).toHaveTextContent("This Song is playing on the Stage now");
    });
  });
});

describe("the Songs section with a read-only Library", () => {
  it("says why and disables every Library write, whatever the Unlock", async () => {
    screenFor(true);
    const server = fakeLibraryServer({
      "GET /api/server-info": {
        version: "dev",
        schemaVersion: 1,
        libraryReadOnly: { code: "songsFolderNotWritable", songsDir: "/songs" },
        publicUrl: null,
      },
      "GET /api/songs": songList(SONGS),
      "GET /api/library/originals": [1],
      "GET /api/library/trash": {
        songs: [{ id: 4, originalPath: "Old - Song", deletedMs: 0 }],
      },
      "GET /api/unlock": { unlocked: true },
    });
    await renderLive(<SongsInRouter />);

    expect(
      screen.getByText(
        "OpenStar cannot write to the songs folder /songs, so the Library is read-only",
      ),
    ).toBeVisible();
    const writes = [
      screen.getByRole("button", { name: "Restore Original" }),
      screen.getByRole("button", { name: "Delete Waterloo" }),
      screen.getByRole("button", { name: "Delete Bohemian Rhapsody" }),
      screen.getByRole("button", { name: "Restore Old - Song" }),
    ];
    for (const button of writes)
      expect(button).toHaveAttribute("aria-disabled", "true");

    vi.useFakeTimers();
    for (const button of writes) {
      act(() => {
        fireEvent.click(button);
        fireEvent.pointerDown(button);
      });
      act(() => {
        vi.advanceTimersByTime(HOLD_DURATION_MS);
      });
      act(() => {
        fireEvent.pointerUp(button);
      });
    }
    vi.useRealTimers();
    await settle();
    expect(
      server.calls.filter((call) => !call.startsWith("GET ")),
    ).toEqual([]);
  });
});

describe("Restore Original while the Song plays on the Stage", () => {
  const party = (songId: number | null): PartySnapshot => ({
    partyId: "p1",
    stageId: "main",
    joinCode: "0427",
    startedAtMs: 1000,
    members: [],
    phones: [],
    queue: [],
    head: null,
    lineUp: null,
    playing: songId === null ? null : { requestId: 1, songId, paused: false },
    results: null,
    localMics: [],
  });
  const REASON =
    "Not while this Song plays on the Stage, so nobody's Notes move mid-Song";

  it("is disabled for that Song with the reason, live, and enabled when it stops", async () => {
    screenFor(true);
    const server = fakeLibraryServer({
      "GET /api/songs": songList(SONGS),
      "GET /api/library/originals": [1, 2],
      "GET /api/unlock": { unlocked: true },
    });
    const live = await renderLive((store) => <SongsInRouter store={store} />);
    const buttons = () =>
      screen.getAllByRole("button", { name: "Restore Original" });
    const told = (songId: number | null) =>
      live.receive({
        type: "liveState",
        stageId: "main",
        isStage: false,
        party: party(songId),
      });

    await told(1);
    expect(buttons()[0]).toHaveAttribute("aria-disabled", "true");
    expect(buttons()[1]).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText(REASON)).toHaveLength(1);
    act(() => {
      fireEvent.click(buttons()[0] as HTMLElement);
    });
    await settle();
    expect(server.count("POST /api/songs/1/restore-original")).toBe(0);

    await told(null);
    expect(buttons()[0]).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(REASON)).toBeNull();
  });
});
