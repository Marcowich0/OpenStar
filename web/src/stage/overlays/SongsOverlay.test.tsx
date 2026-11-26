import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
