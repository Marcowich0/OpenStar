import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { profileStatsQuery } from "../../api/queries";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import {
  guestMember,
  partyOf,
  profile,
  profileMember,
} from "../../phone/people/testPhone";
import { STATS_ADA } from "../../profile/profileStatsFixture";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { click, renderOverlays, press } from "./testOverlay";

const bo = guestMember(1, "Bo", "sky", { onPhone: false });
const lea = profileMember(2, 7, "tangerine");
const kim = guestMember(3, "Kim", "cherry", { singing: true });
const PROFILES = [profile(7, "Lea")];

const party = (more: Partial<PartySnapshot> = {}): PartySnapshot => ({
  ...partyOf([bo, lea, kim]),
  joinCode: "4821",
  ...more,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function openPeople(snapshot = party()) {
  const view = renderOverlays(snapshot, { profiles: PROFILES });
  press("p");
  return view;
}

const dialog = () => screen.getByRole("dialog", { name: "Tonight's Party" });
const spots = () =>
  within(
    within(dialog()).getByRole("list", { name: "Party colours" }),
  ).getAllByRole("listitem");
const spotAt = (place: number) => {
  const found = spots()[place];
  if (!found) throw new Error(`no spot ${String(place)}`);
  return found;
};
const spot = (name: string) => {
  const found = spots().find((s) => within(s).queryByText(name));
  if (!found) throw new Error(`no spot for ${name}`);
  return found;
};

function hold(button: HTMLElement) {
  act(() => {
    button.focus();
  });
  act(() => {
    fireEvent.keyDown(button, { key: "Enter" });
  });
  act(() => {
    vi.advanceTimersByTime(HOLD_DURATION_MS);
  });
  act(() => {
    fireEvent.keyUp(button, { key: "Enter" });
  });
}

describe("People overlay", () => {
  it("is headed Tonight's Party with how many of the 12 colours are taken", () => {
    openPeople();
    expect(within(dialog()).getByText("3 of 12 colours taken")).toBeVisible();
  });

  it("lays out the twelve Party colours in palette order", () => {
    openPeople();
    expect(spots().map((s) => s.dataset.colour)).toEqual([
      "cherry",
      "sky",
      "navy",
      "cocoa",
      "teal",
      "lime",
      "berry",
      "mint",
      "bubblegum",
      "forest",
      "grape",
      "tangerine",
    ]);
    expect(
      within(dialog()).getByRole("list", { name: "Party colours" }),
    ).toHaveClass("grid-cols-6");
  });

  it("shows who holds a taken colour: avatar, name, Profile or Guest, Phone or Local mic", () => {
    openPeople();
    const lea_ = spotAt(11);
    expect(within(lea_).getByRole("img", { name: "Lea" })).toBeVisible();
    expect(within(lea_).getByText("Profile")).toBeVisible();
    expect(within(lea_).getByText("Phone")).toBeVisible();
    const bo_ = spotAt(1);
    expect(within(bo_).getByText("Bo")).toBeVisible();
    expect(within(bo_).getByText("Guest")).toBeVisible();
    expect(within(bo_).getByText("Local mic")).toBeVisible();
    expect(
      within(bo_).getByRole("button", { name: "Hold to remove Bo" }),
    ).toBeVisible();
  });

  it("labels a free colour with its display name", () => {
    openPeople();
    const navy = spotAt(2);
    expect(navy).toHaveAccessibleName("Navy is free");
    expect(within(navy).getByText("Navy is free")).toBeVisible();
    expect(within(navy).queryByRole("button")).toBeNull();
    expect(navy.querySelector("[data-free-ring]")).toHaveAttribute(
      "style",
      expect.stringContaining("--color-party-navy"),
    );
  });

  it("tags a Party member in the Line-up as singing, with no remove control", () => {
    openPeople();
    const kim_ = spot("Kim");
    expect(within(kim_).getByText("singing")).toBeVisible();
    expect(within(kim_).queryByRole("button")).toBeNull();
  });

  it("removes a Party member after a hold, not on a click", () => {
    vi.useFakeTimers();
    const { sent } = openPeople();
    const remove = within(spot("Bo")).getByRole("button", {
      name: "Hold to remove Bo",
    });
    act(() => {
      fireEvent.click(remove);
    });
    expect(sent).not.toContainEqual({ type: "removeMember", memberId: 1 });
    hold(remove);
    expect(sent).toContainEqual({ type: "removeMember", memberId: 1 });
  });

  it("shows why a removal was refused", async () => {
    vi.useFakeTimers();
    const { reject } = openPeople();
    hold(within(spot("Bo")).getByRole("button", { name: "Hold to remove Bo" }));
    reject({ code: "memberSinging" });
    await act(async () => {});
    expect(within(dialog()).getByRole("alert")).toBeVisible();
  });

  it("frees the colour in the grid once the member has left", () => {
    const { changeParty } = openPeople();
    changeParty(party({ members: [lea, kim] }));
    expect(spotAt(1)).toHaveAccessibleName("Sky is free");
    expect(within(dialog()).getByText("2 of 12 colours taken")).toBeVisible();
  });

  it("starts a New party after a hold; the grid and the join card show the new Party", () => {
    vi.useFakeTimers();
    const { sent, changeParty } = openPeople();
    hold(within(dialog()).getByRole("button", { name: "New party" }));
    expect(sent).toContainEqual({ type: "newParty" });
    changeParty(party({ partyId: "p2", joinCode: "0427", members: [] }));
    expect(within(dialog()).getByText("0 of 12 colours taken")).toBeVisible();
    expect(spots().every((s) => s.dataset.free === "true")).toBe(true);
    expect(within(dialog()).getByTestId("party-join-code")).toHaveTextContent(
      "0427",
    );
  });

  it("always shows the Join code, even with the song browser's card hidden", () => {
    window.localStorage.setItem("openstar.joinCardHidden", "true");
    openPeople();
    expect(within(dialog()).getByTestId("party-join-code")).toHaveTextContent(
      "4821",
    );
    expect(within(dialog()).queryByRole("button", { name: "Hide" })).toBeNull();
    expect(
      within(dialog()).getByRole("img", { name: "QR code to join the Party" }),
    ).toBeVisible();
  });

  it("opens a Profile's page from its spot, and Esc goes back to the overlay", () => {
    const { queries } = openPeople();
    queries.setQueryData(profileStatsQuery(7).queryKey, STATS_ADA);
    const open = within(spot("Lea")).getByRole("button", {
      name: "Open Lea's Profile page",
    });
    act(() => {
      open.focus();
    });
    click(open);
    const page = screen.getByRole("dialog", { name: "Lea's Profile page" });
    expect(
      within(page).getByRole("heading", { name: "Lea" }),
    ).toBeInTheDocument();
    expect(within(page).getByText("Songs sung")).toBeInTheDocument();
    // The Stage's arrows and Enter stay inside the page while it is up.
    expect(page).toContainElement(document.activeElement as HTMLElement);

    press("Escape");
    expect(
      screen.queryByRole("dialog", { name: "Lea's Profile page" }),
    ).toBeNull();
    expect(dialog()).toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("offers no Profile page for a Guest", () => {
    openPeople();
    expect(
      within(spot("Bo")).queryByRole("button", { name: /Profile page/ }),
    ).toBeNull();
  });

  it("never offers to delete a Profile", () => {
    openPeople();
    expect(within(dialog()).queryByText(/delete/i)).toBeNull();
  });
});
