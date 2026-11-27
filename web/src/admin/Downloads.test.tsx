import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsdbMirrorStatus } from "../generated/UsdbMirrorStatus";
import type { UsdbSearchResults } from "../generated/UsdbSearchResults";
import type { UsdbSong } from "../generated/UsdbSong";
import type { UsdbState } from "../generated/UsdbState";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Downloads } from "./Downloads";

function usdbSong(
  usdbId: number,
  artist: string,
  title: string,
  inLibrary = false,
): UsdbSong {
  return {
    usdbId,
    artist,
    title,
    genre: "Pop",
    year: 1999,
    edition: "",
    golden: false,
    language: "English",
    creator: "someone",
    rating: 4.5,
    views: 1234,
    inLibrary,
    cover: `/api/usdb/songs/${String(usdbId)}/cover`,
    tileColour: "sky",
  };
}

const SONGS = [
  usdbSong(11, "Placeholder Band", "First Tune", true),
  usdbSong(12, "Other Artist", "Second Tune"),
];

function results(songs: UsdbSong[], total = songs.length): UsdbSearchResults {
  return { songs, total };
}

function mirror(
  state: UsdbMirrorStatus["state"],
  songs = 2,
  lastFailure: UsdbMirrorStatus["lastFailure"] = null,
): UsdbMirrorStatus {
  return {
    state,
    songs,
    lastRefreshedMs: null,
    lastFullMs: null,
    lastFailure,
  };
}

function usdbServer(
  answers: {
    status?: UsdbState;
    mirror?: UsdbMirrorStatus | (() => UsdbMirrorStatus);
    songs?: UsdbSearchResults | ((url: URL) => UsdbSearchResults);
  } = {},
) {
  const status = { state: answers.status ?? "loggedIn" };
  const mirrorStatus = answers.mirror ?? mirror({ type: "fresh" });
  return fakeLibraryServer({
    "GET /api/usdb/status": status,
    "GET /api/usdb/mirror": mirrorStatus,
    "POST /api/usdb/mirror/refresh": mirrorStatus,
    "POST /api/usdb/mirror/refetch": () =>
      mirror({ type: "refreshing", full: true, percent: null }),
    "GET /api/usdb/songs": answers.songs ?? results(SONGS),
  });
}

const list = () => screen.getByRole("list", { name: "USDB songs" });
const rows = () => within(list()).getAllByRole("listitem");
const notices = () => {
  const box = document.querySelector("[data-section-notices]");
  if (!(box instanceof HTMLElement)) throw new Error("no notices");
  return box;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Downloads section", () => {
  it("lists the mirror's songs with cover, title, artist, rating and views", async () => {
    usdbServer();
    await renderLive((store) => <Downloads store={store} />);

    const [first, second] = rows();
    expect(first).toHaveTextContent("First Tune");
    expect(first).toHaveTextContent("Placeholder Band");
    expect(first).toHaveTextContent("4.5");
    expect(first).toHaveTextContent("1,234 views");
    expect(first?.querySelector("img")).toHaveAttribute(
      "src",
      "/api/usdb/songs/11/cover",
    );
    expect(second).toHaveTextContent("Second Tune");
  });

  it("marks only the songs already in the Library", async () => {
    usdbServer();
    await renderLive((store) => <Downloads store={store} />);

    const [first, second] = rows();
    expect(within(first as HTMLElement).getByText("In Library")).toBeVisible();
    expect(within(second as HTMLElement).queryByText("In Library")).toBeNull();
  });

  it("searches artist and title on the mirror as you type", async () => {
    const server = usdbServer({
      songs: (url) =>
        results(
          url.searchParams.get("search") === "other" ? SONGS.slice(1) : SONGS,
        ),
    });
    await renderLive((store) => <Downloads store={store} />);

    act(() => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "other" },
      });
    });
    await settle();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Second Tune");
    expect(server.calls).toContain(
      "GET /api/usdb/songs?search=other&sort=views",
    );
  });

  it("sorts by views first, and by rating when asked", async () => {
    const server = usdbServer();
    await renderLive((store) => <Downloads store={store} />);
    expect(server.calls).toContain("GET /api/usdb/songs?sort=views");

    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Rating" }));
    });
    await settle();

    expect(server.calls).toContain("GET /api/usdb/songs?sort=rating");
    expect(screen.getByRole("radio", { name: "Rating" })).toBeChecked();
  });

  it("says how many matched when it shows only the first ones", async () => {
    usdbServer({ songs: results(SONGS, 120) });
    await renderLive((store) => <Downloads store={store} />);

    expect(screen.getByText("Showing 2 of 120 songs")).toBeVisible();
  });

  it("says so when nothing matches, and when nothing is mirrored", async () => {
    usdbServer({ songs: results([]) });
    await renderLive((store) => <Downloads store={store} />);
    expect(screen.getByText("No USDB songs are here yet")).toBeVisible();

    act(() => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "nobody" },
      });
    });
    await settle();

    expect(screen.getByText("No USDB songs match")).toBeVisible();
  });

  it("asks for a fresh mirror once when it opens", async () => {
    const server = usdbServer();
    await renderLive((store) => <Downloads store={store} />);

    expect(server.count("POST /api/usdb/mirror/refresh")).toBe(1);
  });

  it("starts a full refetch by hand without the Admin PIN", async () => {
    const server = usdbServer();
    await renderLive((store) => <Downloads store={store} />);

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Fetch the whole list again" }),
      );
    });
    await settle();

    expect(server.count("POST /api/usdb/mirror/refetch")).toBe(1);
    expect(screen.queryByText("Admin PIN")).toBeNull();
    expect(
      screen.getByText("Fetching the whole USDB list again…"),
    ).toBeVisible();
  });

  it("says how to set the credentials when they are missing", async () => {
    usdbServer({
      status: "credentialsMissing",
      mirror: mirror(
        { type: "unavailable", reason: { code: "usdbCredentialsMissing" } },
        0,
      ),
      songs: results([]),
    });
    await renderLive((store) => <Downloads store={store} />);

    const text = notices().textContent;
    expect(text).toContain("OPENSTAR_USDB_USERNAME");
    expect(text).toContain("OPENSTAR_USDB_PASSWORD");
    expect(text).toContain("_FILE");
    // The Admin area is the owner's: the full text, shown, with no fold.
    expect(notices().querySelector("p")).toBeVisible();
    expect(screen.queryByRole("button", { name: "For the owner" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fetch the whole list again" }),
    ).toBeDisabled();
  });

  it("shows “USDB login failed” after a failed login", async () => {
    usdbServer({ status: "loginFailed" });
    await renderLive((store) => <Downloads store={store} />);

    expect(notices()).toHaveTextContent(
      "USDB login failed. Check OPENSTAR_USDB_USERNAME and OPENSTAR_USDB_PASSWORD, then restart OpenStar.",
    );
    expect(screen.queryByRole("button", { name: "For the owner" })).toBeNull();
  });

  it("shows the fill's progress and the songs mirrored so far, and follows the mirror's notices", async () => {
    let status = mirror({ type: "filling", percent: 10 }, 300);
    const server = usdbServer({ mirror: () => status });
    const live = await renderLive((store) => <Downloads store={store} />);

    expect(notices()).toHaveTextContent(
      "Fetching USDB's song list: 10% (300 songs so far)",
    );
    expect(rows()).toHaveLength(2);
    const searches = server.calls.filter((c) =>
      c.startsWith("GET /api/usdb/songs"),
    );

    status = mirror({ type: "filling", percent: 40 }, 1200);
    await live.changed("usdbMirror");

    expect(notices()).toHaveTextContent(
      "Fetching USDB's song list: 40% (1,200 songs so far)",
    );
    expect(
      server.calls.filter((c) => c.startsWith("GET /api/usdb/songs")).length,
    ).toBeGreaterThan(searches.length);
  });

  it("says why the last mirror run failed", async () => {
    usdbServer({
      mirror: mirror({ type: "stale" }, 2, {
        code: "usdbGaveUp",
        params: { status: 503 },
      }),
    });
    await renderLive((store) => <Downloads store={store} />);

    expect(notices()).toHaveTextContent(
      "The last update of the USDB list failed",
    );
    expect(notices()).toHaveTextContent("503");
  });
});
