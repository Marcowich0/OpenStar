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

import type { SongList } from "../generated/SongList";
import type { SongSummary } from "../generated/SongSummary";
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
function SongsInRouter() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Songs });
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

  it("links each Song to its Timing editor", async () => {
    fakeLibraryServer({ "GET /api/songs": songList(SONGS) });
    await renderLive(<SongsInRouter />);

    expect(
      within(rows()[1] as HTMLElement).getByRole("link", {
        name: "Timing of Bohemian Rhapsody",
      }),
    ).toHaveAttribute("href", "/admin/songs/2/timing");
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
});
