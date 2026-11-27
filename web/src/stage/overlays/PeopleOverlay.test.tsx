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
import { t } from "../../i18n/t";
import { PALETTE_KEYS } from "../../theme/tokens";
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

// The title comes from the catalogue, so a rename of it needs no test change.
const dialog = () =>
  screen.getByRole("dialog", { name: t("stage.overlay.people") });
const membersList = () =>
  within(dialog()).getByRole("list", { name: "Party members" });
const cards = () => within(membersList()).getAllByRole("listitem");
const card = (name: string) => {
  const found = cards().find((c) => within(c).queryByText(name));
  if (!found) throw new Error(`no card for ${name}`);
  return found;
};
const freeList = () =>
  within(dialog()).getByRole("list", { name: "Free colours" });
const freeSwatches = () => within(freeList()).getAllByRole("listitem");

/** Twelve Guests, one in each Party colour. */
const fullParty = () =>
  partyOf(
    PALETTE_KEYS.map((colour, i) =>
      guestMember(i + 1, `Guest ${String(i + 1)}`, colour),
    ),
  );

/** `first` comes before `second` in the document. */
function expectBefore(first: Element, second: Element) {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

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
  it("says how many of the 12 colours are taken under its title", () => {
    openPeople();
    expect(within(dialog()).getByText("3 of 12 colours taken")).toBeVisible();
  });

  it("lists the Party members first, as cards in the order they joined, then the free colours", () => {
    openPeople();
    expect(cards().map((c) => c.dataset.colour)).toEqual([
      "sky",
      "tangerine",
      "cherry",
    ]);
    expectBefore(membersList(), freeList());
    expectBefore(freeList(), within(dialog()).getByTestId("party-join-code"));
  });

  it("shows each member's avatar, name, Profile or Guest, and Phone or Local mic", () => {
    openPeople();
    const lea_ = card("Lea");
    expect(within(lea_).getByRole("img", { name: "Lea" })).toBeVisible();
    expect(within(lea_).getByText("Profile")).toBeVisible();
    expect(within(lea_).getByText("Phone")).toBeVisible();
    expect(lea_).toHaveAccessibleName("Lea");
    const bo_ = card("Bo");
    expect(within(bo_).getByText("Guest")).toBeVisible();
    expect(within(bo_).getByText("Local mic")).toBeVisible();
    expect(
      within(bo_).getByRole("button", { name: "Hold to remove Bo" }),
    ).toBeVisible();
  });

  it("tags a Party member in the Line-up as singing, with no remove control", () => {
    openPeople();
    const kim_ = card("Kim");
    expect(within(kim_).getByText("singing")).toBeVisible();
    expect(within(kim_).queryByRole("button")).toBeNull();
  });

  it("shows the free colours as a compact row of named swatches, in palette order", () => {
    openPeople();
    expect(freeSwatches().map((s) => s.textContent)).toEqual([
      "Navy",
      "Cocoa",
      "Teal",
      "Lime",
      "Berry",
      "Mint",
      "Bubblegum",
      "Forest",
      "Grape",
    ]);
    const navy = freeSwatches()[0];
    expect(navy?.querySelector("[data-swatch]")).toHaveAttribute(
      "style",
      expect.stringContaining("--color-party-navy"),
    );
    expect(within(freeList()).queryByRole("button")).toBeNull();
  });

  it("with nobody in the Party, says so above the join card and offers all twelve colours", () => {
    openPeople(party({ members: [] }));
    expect(within(dialog()).getByText("0 of 12 colours taken")).toBeVisible();
    const empty = within(dialog()).getByText("Nobody has joined yet");
    expect(empty).toBeVisible();
    expectBefore(empty, within(dialog()).getByTestId("party-join-code"));
    expect(
      within(dialog()).queryByRole("list", { name: "Party members" }),
    ).toBeNull();
    expect(freeSwatches()).toHaveLength(12);
  });

  it("with all twelve colours taken, shows twelve cards and no free colours", () => {
    openPeople(fullParty());
    expect(within(dialog()).getByText("12 of 12 colours taken")).toBeVisible();
    expect(cards()).toHaveLength(12);
    expect(cards().map((c) => c.dataset.colour)).toEqual([...PALETTE_KEYS]);
    expect(
      within(dialog()).queryByRole("list", { name: "Free colours" }),
    ).toBeNull();
    expect(within(dialog()).queryByText("Nobody has joined yet")).toBeNull();
  });

  it("removes a Party member after a hold, not on a click", () => {
    vi.useFakeTimers();
    const { sent } = openPeople();
    const remove = within(card("Bo")).getByRole("button", {
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
    hold(within(card("Bo")).getByRole("button", { name: "Hold to remove Bo" }));
    reject({ code: "memberSinging" });
    await act(async () => {});
    expect(within(dialog()).getByRole("alert")).toBeVisible();
  });

  it("frees the colour once the member has left", () => {
    const { changeParty } = openPeople();
    changeParty(party({ members: [lea, kim] }));
    expect(cards()).toHaveLength(2);
    expect(within(freeList()).getByText("Sky")).toBeVisible();
    expect(within(dialog()).getByText("2 of 12 colours taken")).toBeVisible();
  });

  it("styles New party as destructive and says what it clears", () => {
    openPeople();
    const button = within(dialog()).getByRole("button", { name: "New party" });
    expect(button).toHaveClass("text-red", "ring-red");
    expect(button).not.toHaveClass("bg-red");
    expect(button).toHaveAccessibleDescription(
      "Clears the Queue and the people, and makes a new Join code",
    );
    expect(
      within(dialog()).getByText(
        "Clears the Queue and the people, and makes a new Join code",
      ),
    ).toBeVisible();
  });

  it("starts a New party after a hold, not on a click; the cards and the join card show the new Party", () => {
    vi.useFakeTimers();
    const { sent, changeParty } = openPeople();
    const button = within(dialog()).getByRole("button", { name: "New party" });
    act(() => {
      fireEvent.click(button);
    });
    expect(sent).not.toContainEqual({ type: "newParty" });
    hold(button);
    expect(sent).toContainEqual({ type: "newParty" });
    changeParty(party({ partyId: "p2", joinCode: "0427", members: [] }));
    expect(within(dialog()).getByText("0 of 12 colours taken")).toBeVisible();
    expect(within(dialog()).getByText("Nobody has joined yet")).toBeVisible();
    expect(freeSwatches()).toHaveLength(12);
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

  it("opens a Profile's page from its card, and Esc goes back to the overlay", () => {
    const { queries } = openPeople();
    queries.setQueryData(profileStatsQuery(7).queryKey, STATS_ADA);
    const open = within(card("Lea")).getByRole("button", {
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
      within(card("Bo")).queryByRole("button", { name: /Profile page/ }),
    ).toBeNull();
  });

  it("never offers to delete a Profile", () => {
    openPeople();
    expect(within(dialog()).queryByText(/delete/i)).toBeNull();
  });
});
