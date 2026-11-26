import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsdbSong } from "../generated/UsdbSong";
import type { UsdbVideoCandidates } from "../generated/UsdbVideoCandidates";
import type { VideoDetails } from "../generated/VideoDetails";
import { fakeLibraryServer, renderLive, settle } from "./adminTestKit";
import { Downloads } from "./Downloads";

const SONG: UsdbSong = {
  usdbId: 11,
  artist: "Placeholder Band",
  title: "First Tune",
  genre: "Pop",
  year: 1999,
  edition: "",
  golden: false,
  language: "English",
  creator: "someone",
  rating: 4.5,
  views: 1234,
  inLibrary: false,
  cover: "/api/usdb/songs/11/cover",
  tileColour: "sky",
};

const TAG = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
const COMMENT = "https://vimeo.com/123456";
const HIT = "https://www.youtube.com/watch?v=stubsearch1";

function picker(
  overrides: Partial<UsdbVideoCandidates> = {},
): UsdbVideoCandidates {
  return {
    usdbId: 11,
    songLengthSeconds: 213.4,
    candidates: [
      { url: TAG, source: "videoTag", details: null },
      { url: COMMENT, source: "comment", details: null },
      {
        url: HIT,
        source: "search",
        details: {
          title: "First Tune (official video)",
          durationSeconds: 215,
          thumbnail: "https://i.ytimg.com/vi/stubsearch1/hqdefault.jpg",
        },
      },
    ],
    searchFailure: null,
    ...overrides,
  };
}

const TAG_DETAILS: VideoDetails = {
  title: "First Tune (lyric video)",
  durationSeconds: 214,
  thumbnail: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
};

function server(
  answers: {
    candidates?: UsdbVideoCandidates | Response;
    details?: (url: string) => VideoDetails | Response;
  } = {},
) {
  return fakeLibraryServer({
    "GET /api/usdb/status": { state: "loggedIn" },
    "GET /api/usdb/mirror": {
      state: { type: "fresh" },
      songs: 1,
      lastRefreshedMs: null,
      lastFullMs: null,
      lastFailure: null,
    },
    "POST /api/usdb/mirror/refresh": {
      state: { type: "fresh" },
      songs: 1,
      lastRefreshedMs: null,
      lastFullMs: null,
      lastFailure: null,
    },
    "GET /api/usdb/songs": { songs: [SONG], total: 1 },
    "GET /api/usdb/songs/11/videos": () => answers.candidates ?? picker(),
    "GET /api/usdb/video-details": (url: URL) =>
      (answers.details ?? (() => TAG_DETAILS))(
        url.searchParams.get("url") ?? "",
      ),
  });
}

function unavailable() {
  return new Response(
    JSON.stringify({
      code: "toolFailed",
      params: { tool: "yt-dlp", exitCode: 1 },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}

async function openPicker() {
  await renderLive(<Downloads />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /First Tune/ }));
  });
  await settle();
  return screen.getByRole("dialog", {
    name: "Choose the video for First Tune",
  });
}

const options = (dialog: HTMLElement) => within(dialog).getAllByRole("radio");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the video picker", () => {
  it("opens from a USDB result and lists the candidates in the server's order", async () => {
    const calls = server();
    const dialog = await openPicker();

    const [tag, comment, hit] = options(dialog);
    expect(options(dialog)).toHaveLength(3);
    expect(tag?.closest("label")).toHaveTextContent("From the text");
    expect(comment?.closest("label")).toHaveTextContent("From a comment");
    expect(hit?.closest("label")).toHaveTextContent("Search result");
    expect(calls.calls).toContain("GET /api/usdb/songs/11/videos");
    // Opening it asks for no PIN.
    expect(within(dialog).queryByText(/PIN/)).toBeNull();
  });

  it("preselects the first candidate", async () => {
    server();
    const dialog = await openPicker();

    const [first, second] = options(dialog);
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();

    act(() => {
      fireEvent.click(second as HTMLElement);
    });
    expect(second).toBeChecked();
  });

  it("shows each candidate's thumbnail, title and duration beside the Song's length", async () => {
    const calls = server();
    const dialog = await openPicker();

    expect(within(dialog).getByText("Song length 3:33")).toBeVisible();
    const tag = options(dialog)[0]?.closest("label") as HTMLElement;
    expect(tag).toHaveTextContent("First Tune (lyric video)");
    expect(tag).toHaveTextContent("3:34");
    expect(tag.querySelector("img")).toHaveAttribute(
      "src",
      TAG_DETAILS.thumbnail,
    );
    const hit = options(dialog)[2]?.closest("label") as HTMLElement;
    expect(hit).toHaveTextContent("First Tune (official video)");
    expect(hit).toHaveTextContent("3:35");
    // A search hit's details came with it; the others are looked up.
    expect(
      calls.calls.filter((call) =>
        call.startsWith("GET /api/usdb/video-details"),
      ),
    ).toEqual([
      `GET /api/usdb/video-details?url=${encodeURIComponent(TAG)}`,
      `GET /api/usdb/video-details?url=${encodeURIComponent(COMMENT)}`,
    ]);
  });

  it("shows a candidate yt-dlp cannot read as unavailable, and the rest as usual", async () => {
    server({
      details: (url) => (url === COMMENT ? unavailable() : TAG_DETAILS),
    });
    const dialog = await openPicker();

    const [tag, comment] = options(dialog).map(
      (radio) => radio.closest("label") as HTMLElement,
    );
    expect(comment).toHaveTextContent("Unavailable");
    expect(comment).toHaveTextContent(COMMENT);
    expect(tag).toHaveTextContent("First Tune (lyric video)");
  });

  it("says when the search failed and still offers USDB's own links", async () => {
    server({
      candidates: picker({
        candidates: [{ url: TAG, source: "videoTag", details: null }],
        searchFailure: {
          code: "toolFailed",
          params: { tool: "yt-dlp", exitCode: 1 },
        },
      }),
    });
    const dialog = await openPicker();

    expect(within(dialog).getByText(/The video search failed/)).toBeVisible();
    expect(options(dialog)).toHaveLength(1);
  });

  it("says when the Song's length is unknown and when no video was found", async () => {
    server({
      candidates: picker({ songLengthSeconds: null, candidates: [] }),
    });
    const dialog = await openPicker();

    expect(within(dialog).getByText("Song length unknown")).toBeVisible();
    expect(within(dialog).getByText("No videos found")).toBeVisible();
  });

  it("says why the picker could not open", async () => {
    server({
      candidates: new Response(JSON.stringify({ code: "usdbUnreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const dialog = await openPicker();

    expect(within(dialog).getByRole("alert")).toHaveTextContent(/USDB/);
  });
});
