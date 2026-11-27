import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { songsQuery } from "../../api/queries";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import { partyOf } from "../../phone/people/testPhone";
import { click, press, renderOverlays, request, summary } from "./testOverlay";

const SONGS = [summary(1, "Africa"), summary(2, "Islands"), summary(3, "Moon")];

const party = (more: Partial<PartySnapshot> = {}): PartySnapshot => ({
  ...partyOf([]),
  ...more,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openSongs(snapshot = party()) {
  const view = renderOverlays(snapshot, { songs: SONGS });
  press("s");
  return view;
}

const dialog = () => screen.getByRole("dialog", { name: "Songs" });
const selected = () => within(dialog()).getByTestId("carousel-selected");

async function settle() {
  await act(async () => {});
}

describe("the Songs overlay", () => {
  it("shows the song browser's cover carousel, the selected cover focused", () => {
    openSongs();
    expect(selected()).toHaveAccessibleName(/Africa/);
    expect(document.activeElement).toBe(selected());
    press("ArrowRight");
    expect(selected()).toHaveAccessibleName(/Islands/);
    expect(
      within(dialog()).getByTestId("songs-overlay-title"),
    ).toHaveTextContent("Islands");
  });

  it("adds the selected Song as a Request from the Stage on Enter and confirms it", async () => {
    const { sent, changeParty } = openSongs();
    press("ArrowRight");
    press("Enter");
    expect(sent.at(-1)).toEqual({
      type: "addRequest",
      songId: 2,
      requestedPlayers: null,
    });
    changeParty(party({ queue: [request(5, 2)], head: 5 }));
    await settle();
    expect(within(dialog()).getByRole("status")).toHaveTextContent(
      "Added Islands",
    );
    // The overlay stays open to add more.
    expect(dialog()).toBeVisible();
    press("ArrowRight");
    expect(within(dialog()).queryByText("Added Islands")).toBeNull();
  });

  it("shows a refusal in the overlay", async () => {
    const { reject } = openSongs();
    click(selected());
    reject({ code: "songPreparing" });
    await settle();
    expect(within(dialog()).getByRole("status")).not.toHaveTextContent("Added");
    expect(within(dialog()).getByRole("status")).not.toBeEmptyDOMElement();
  });

  it("says when the Library has no Songs", () => {
    renderOverlays(party(), { songs: [] });
    press("s");
    expect(
      within(dialog()).getByText("No Songs in the Library yet"),
    ).toBeVisible();
  });
});

describe("search in the Songs overlay", () => {
  const box = () =>
    within(dialog()).getByRole("searchbox", {
      name: "Search songs or artists",
    });

  it("opens on /, narrows the overlay's carousel, and Esc clears it before closing", () => {
    const { queries } = openSongs();
    const all = queries.getQueryData(songsQuery().queryKey);
    if (!all) throw new Error("no Song list");
    queries.setQueryData(songsQuery({ search: "moon" }).queryKey, {
      ...all,
      songs: all.songs.filter((song) => song.title === "Moon"),
    });
    press("/");
    expect(document.activeElement).toBe(box());
    act(() => {
      fireEvent.change(box(), { target: { value: "moon" } });
    });
    expect(selected()).toHaveAccessibleName(/Moon/);
    expect(within(dialog()).queryByTestId("carousel-cover-1")).toBeNull();
    press("Escape");
    expect(within(dialog()).queryByRole("searchbox")).toBeNull();
    expect(
      within(dialog()).getByTestId("carousel-cover-1"),
    ).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("dialog", { name: "Songs" })).toBeNull();
  });

  it("opens from the Search button too, with the focus in the box", () => {
    openSongs();
    click(within(dialog()).getByRole("button", { name: "Search" }));
    expect(document.activeElement).toBe(box());
    expect(
      within(dialog()).queryByRole("button", { name: "Search" }),
    ).toBeNull();
  });

  it("takes s, q and p typed into the box as text, not as overlay keys", () => {
    openSongs();
    press("/");
    for (const key of ["s", "q", "p", "m"]) press(key);
    expect(dialog()).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Queue" })).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("has no Mute button: the overlay plays no preview", () => {
    openSongs();
    expect(
      within(dialog()).queryByRole("button", { name: "Mute preview" }),
    ).toBeNull();
  });
});
