import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fakeLibraryServer,
  renderLive,
  settle,
} from "../../admin/adminTestKit";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { UsdbMirrorStatus } from "../../generated/UsdbMirrorStatus";
import type { UsdbSong } from "../../generated/UsdbSong";
import { Button } from "../../ui/Button";
import { SCENES } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const party: PartySnapshot = {
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
};

const song = (usdbId: number, title: string): UsdbSong => ({
  usdbId,
  artist: "Placeholder Band",
  title,
  genre: "Pop",
  year: 1999,
  edition: "",
  golden: false,
  language: "English",
  creator: "someone",
  rating: 4.5,
  views: 1234,
  inLibrary: false,
  cover: `/api/usdb/songs/${String(usdbId)}/cover`,
  tileColour: "sky",
});

const FRESH: UsdbMirrorStatus = {
  state: { type: "fresh" },
  songs: 2,
  lastRefreshedMs: null,
  lastFullMs: null,
  lastFailure: null,
};

const answer = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

function usdbServer() {
  return fakeLibraryServer({
    "GET /api/usdb/status": { state: "loggedIn" },
    "GET /api/usdb/mirror": FRESH,
    "POST /api/usdb/mirror/refresh": FRESH,
    "GET /api/usdb/songs": {
      songs: [song(11, "First Tune"), song(12, "Second Tune")],
      total: 2,
    },
    "GET /api/jobs": { jobs: [] },
    "GET /api/usdb/songs/11/videos": {
      usdbId: 11,
      songLengthSeconds: 213,
      candidates: [
        {
          url: "https://www.youtube.com/watch?v=stubsearch1",
          source: "search",
          details: { title: "First Tune", durationSeconds: 215, thumbnail: "" },
        },
      ],
      searchFailure: null,
    },
    "POST /api/downloads": () => answer(401, { code: "unlockRequired" }),
  });
}

/** The song browser as a stand-in with one default button (see `StageFrame.test.tsx`). */
function BrowserStandIn() {
  return (
    <span data-stage-default>
      <Button onPress={() => {}}>Browse</Button>
    </span>
  );
}

async function setup() {
  const server = usdbServer();
  const view = await renderLive((store) => (
    <StageFrame
      store={store}
      scenes={{ ...SCENES, songBrowser: { component: BrowserStandIn } }}
    />
  ));
  await view.receive({
    type: "liveState",
    stageId: "main",
    party,
    isStage: true,
  });
  return { server, ...view };
}

function key(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

/**
 * jsdom lays nothing out: gives every focusable in the open overlay a row of
 * its own, in document order, so ↓ and ↑ walk them in that order.
 */
function stackFocusables(dialog: HTMLElement) {
  dialog
    .querySelectorAll<HTMLElement>("button, [data-stage-focus]")
    .forEach((element, index) => {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(100, 100 + index * 100, 200, 60),
      );
    });
}

const overlay = () => screen.getByRole("dialog", { name: "Downloads" });
/** The overlay, also while a dialog above it hides it from the accessibility tree. */
const overlayOpen = () =>
  document.querySelector('[data-overlay="downloads"]') !== null;
const searchBox = () =>
  within(overlay()).getByRole("searchbox", {
    name: "Search USDB by artist or title",
  });

async function openDownloads() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
  });
  const menu = screen.getByRole("menu", { name: "Setup" });
  act(() => {
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Downloads" }));
  });
  await settle();
  return overlay();
}

describe("the Stage's Downloads overlay", () => {
  it("opens from the Setup menu with the Admin area's Downloads section", async () => {
    await setup();
    const dialog = await openDownloads();

    // One heading: the overlay's; the section's own is left out.
    expect(within(dialog).getAllByRole("heading", { level: 2 })).toHaveLength(
      1,
    );
    const rows = within(
      within(dialog).getByRole("list", { name: "USDB songs" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("First Tune") as string,
      expect.stringContaining("Second Tune") as string,
    ]);
    // It stays on the Stage: the frame is still there, under the overlay.
    expect(document.querySelector("[data-stage-frame]")).not.toBeNull();
    expect(dialog.closest("[data-overlay]")).toHaveAttribute(
      "data-overlay",
      "downloads",
    );
  });

  it("takes typing in the search box without the Stage's letter keys", async () => {
    const { server } = await setup();
    const dialog = await openDownloads();
    stackFocusables(dialog);

    // ↓ walks from the close button over the refetch button to the search box.
    expect(document.activeElement).toHaveAccessibleName("Close");
    key("ArrowDown");
    key("ArrowDown");
    expect(document.activeElement).toBe(searchBox());

    // S, Q and P are letters here, not the Songs, Queue and People overlays.
    for (const letter of ["s", "q", "p"]) key(letter);
    act(() => {
      fireEvent.change(searchBox(), { target: { value: "sqp" } });
    });
    await settle();
    expect(overlay()).toBeInTheDocument();
    expect(searchBox()).toHaveValue("sqp");
    expect(server.calls).toContain("GET /api/usdb/songs?search=sqp&sort=views");

    // ↓ leaves the box for the sort, ↑ comes back and goes on up.
    key("ArrowDown");
    expect(document.activeElement).toHaveTextContent("Views");
    key("ArrowUp");
    expect(document.activeElement).toBe(searchBox());
    key("ArrowUp");
    expect(document.activeElement).toHaveAccessibleName(
      "Fetch the whole list again",
    );
  });

  it("closes on Esc and gives the focus back to Setup", async () => {
    await setup();
    const setupPill = screen.getByRole("button", { name: "Setup" });
    act(() => {
      setupPill.focus();
    });
    await openDownloads();

    key("Escape");
    expect(screen.queryByRole("dialog", { name: "Downloads" })).toBeNull();
    expect(document.activeElement).toBe(setupPill);
  });

  it("leaves the video picker's keys to it, and asks for the Admin PIN to download", async () => {
    const { server } = await setup();
    const dialog = await openDownloads();
    const [first] = within(dialog).getAllByRole("listitem");
    act(() => {
      fireEvent.click(within(first as HTMLElement).getByRole("button"));
    });
    await settle();
    const picker = screen.getByRole("dialog", {
      name: "Choose the video for First Tune",
    });
    expect(picker.closest("[data-stage-frame]")).toBeNull();

    // The picker holds the focus: the frame neither moves it nor opens Songs.
    const download = within(picker).getByRole("button", { name: "Download" });
    act(() => {
      download.focus();
    });
    key("ArrowUp");
    key("s");
    expect(document.activeElement).toBe(download);
    expect(screen.queryByRole("dialog", { name: "Songs" })).toBeNull();

    // Starting the Download is guarded: without an Unlock the PIN pad opens.
    act(() => {
      fireEvent.click(download);
    });
    await settle();
    expect(server.count("POST /api/downloads")).toBe(1);
    const pad = screen.getByRole("dialog", { name: "Admin PIN" });
    expect(pad.closest("[data-stage-frame]")).toBeNull();

    // In the pad, digits are the PIN's, and arrows leave its focus alone.
    const one = within(pad).getByRole("button", { name: "1" });
    act(() => {
      one.focus();
    });
    key("ArrowDown");
    expect(document.activeElement).toBe(one);

    // Esc closes the pad, then the picker, and only then the overlay.
    key("Escape");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
    });
    expect(overlayOpen()).toBe(true);
    act(() => {
      within(picker).getByRole("button", { name: "Download" }).focus();
    });
    key("Escape");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Choose the video for First Tune",
        }),
      ).toBeNull();
    });
    expect(overlay()).toBeInTheDocument();
  });
});
