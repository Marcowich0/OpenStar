import { act, fireEvent, screen, within } from "@testing-library/react";
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

const list = () => screen.getByRole("list", { name: "Songs in the Library" });
const rows = () => within(list()).getAllByRole("listitem");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Songs section", () => {
  it("lists every playable Song with its cover, title and artist", async () => {
    fakeLibraryServer({ "GET /api/songs": songList(SONGS) });
    await renderLive(<Songs />);

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
    await renderLive(<Songs />);

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
    await renderLive(<Songs />);
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

  it("refreshes on the Library change notice", async () => {
    let songs = SONGS;
    const server = fakeLibraryServer({
      "GET /api/songs": () => songList(songs),
    });
    const live = await renderLive(<Songs />);
    expect(rows()).toHaveLength(2);

    songs = [...SONGS, song(3, "Toto", "Africa", false)];
    await live.changed("library");

    expect(rows()).toHaveLength(3);
    expect(server.count("GET /api/songs")).toBe(2);
  });

  describe("Restore Original", () => {
    const restore = () =>
      screen.queryAllByRole("button", { name: "Restore Original" });

    it("is offered only on a Song that has an Original", async () => {
      fakeLibraryServer({
        "GET /api/songs": songList(SONGS),
        "GET /api/library/originals": [2],
      });
      await renderLive(<Songs />);

      const [abba, queen] = rows();
      expect(
        within(abba!).queryByRole("button", { name: "Restore Original" }),
      ).toBeNull();
      expect(
        within(queen!).getByRole("button", { name: "Restore Original" }),
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
      const live = await renderLive(<Songs />);

      act(() => {
        fireEvent.click(restore()[0]!);
      });
      await settle();
      expect(server.count("POST /api/songs/1/restore-original")).toBe(1);

      await live.changed("library");
      expect(restore()).toHaveLength(0);
    });

    it("says why the server refused it", async () => {
      fakeLibraryServer({
        "GET /api/songs": songList(SONGS),
        "GET /api/library/originals": [1],
        "GET /api/unlock": { unlocked: true },
      });
      const answer = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string, init: RequestInit) =>
        input.endsWith("/api/songs/1/restore-original")
          ? Promise.resolve(
              new Response(JSON.stringify({ code: "songPlaying" }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
              }),
            )
          : answer(input, init),
      );
      await renderLive(<Songs />);

      act(() => {
        fireEvent.click(restore()[0]!);
      });
      await settle();
      expect(within(rows()[0]!).getByRole("alert")).toHaveTextContent(
        "This Song is playing on the Stage now",
      );
    });
  });
});
