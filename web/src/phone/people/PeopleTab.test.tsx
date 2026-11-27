import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STATS_ADA } from "../../profile/profileStatsFixture";
import { HOLD_DURATION_MS } from "../../ui/hold";
import {
  guestMember,
  partyOf,
  profile,
  profileMember,
  profilesFetch,
  renderJoinedPhone,
} from "./testPhone";

const PROFILES = [
  profile(7, "Bo", { favouriteColour: "cherry" }),
  profile(8, "Lukas", { favouriteColour: "cherry" }),
  profile(9, "Ada", { favouriteColour: "teal" }),
];

const bo = profileMember(1, 7, "cherry");
const lukas = profileMember(2, 8, "tangerine", {
  favouriteTaken: true,
  onPhone: false,
});
const kim = guestMember(3, "Kim", "lime");
const ada = profileMember(4, 9, "teal", { singing: true });
const PARTY = partyOf([bo, lukas, kim, ada]);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(profilesFetch(PROFILES)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openPeople(snapshot = PARTY) {
  const phone = renderJoinedPhone(snapshot);
  act(() => {
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
  });
  await screen.findByRole("listitem", { name: /Lukas/ });
  return phone;
}

const row = (name: RegExp) => screen.getByRole("listitem", { name });

describe("the People tab", () => {
  it("opens a Profile's page when its row is tapped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        new URL(input, "http://openstar.test").pathname ===
        "/api/profiles/8/stats"
          ? Promise.resolve(Response.json(STATS_ADA))
          : profilesFetch(PROFILES)(input),
      ),
    );
    await openPeople();
    act(() => {
      fireEvent.click(
        within(row(/Lukas/)).getByRole("button", {
          name: "Lukas's Profile page",
        }),
      );
    });
    const page = await screen.findByRole("dialog", {
      name: "Lukas's Profile page",
    });
    expect(await within(page).findByText("Rounds")).toBeInTheDocument();
  });

  it("offers no Profile page for a Guest", async () => {
    await openPeople();
    expect(
      within(row(/Kim/)).queryByRole("button", { name: /Profile page/ }),
    ).toBeNull();
  });

  it("heads the list with the count, the Join code and what removing does", async () => {
    await openPeople();
    expect(
      screen.getByRole("heading", { name: "Party people" }),
    ).toBeInTheDocument();
    expect(screen.getByText("4 of 12")).toBeInTheDocument();
    expect(screen.getByText(/Join code 4821/)).toBeInTheDocument();
    expect(
      screen.getByText(/Removing someone frees their colour/),
    ).toBeInTheDocument();
  });

  it("shows each member with their tags and whether they are on a Phone", async () => {
    await openPeople();
    expect(within(row(/Bo/)).getByText("me")).toBeInTheDocument();
    expect(within(row(/Bo/)).getByText("On a Phone")).toBeInTheDocument();
    expect(within(row(/Kim/)).getByText("guest")).toBeInTheDocument();
    expect(
      within(row(/Lukas/)).getByText(/Local mic only/),
    ).toBeInTheDocument();
    expect(
      within(row(/Lukas/)).getByText(/favourite Cherry is taken/),
    ).toBeInTheDocument();
    expect(within(row(/Lukas/)).queryByText("me")).toBeNull();
  });

  it("draws each avatar in the member's Party colour", async () => {
    await openPeople();
    const disc = within(row(/Lukas/))
      .getByRole("img", { name: "Lukas" })
      .querySelector("circle");
    expect(disc?.style.fill).toBe("var(--color-party-tangerine)");
  });

  it("offers no × on this Phone's own row, and singing instead of one", async () => {
    await openPeople();
    expect(
      within(row(/Bo/)).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
    expect(
      within(row(/Ada/)).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
    expect(within(row(/Ada/)).getByText("singing")).toBeInTheDocument();
  });

  it("removes a member with a press and hold on the ×, not a tap", async () => {
    const { sent } = await openPeople();
    vi.useFakeTimers();
    const remove = within(row(/Kim/)).getByRole("button", {
      name: "Remove Kim",
    });
    act(() => {
      fireEvent.pointerDown(remove, { button: 0 });
      fireEvent.pointerUp(remove, { button: 0 });
    });
    expect(sent.some((m) => m.type === "removeMember")).toBe(false);
    act(() => {
      fireEvent.pointerDown(remove, { button: 0 });
      vi.advanceTimersByTime(HOLD_DURATION_MS + 10);
    });
    expect(sent).toContainEqual({ type: "removeMember", memberId: 3 });
  });

  it("shows the toast when someone is removed", async () => {
    const { change } = await openPeople();
    change(
      { kind: "member", memberId: 2 },
      {
        code: "memberLeft",
        params: {
          memberId: 3,
          name: "Kim",
          avatar: { kind: "builtIn", key: "flame" },
          colour: "lime",
        },
      },
      partyOf([bo, lukas, ada]),
    );
    expect(
      screen.getByRole("status", { name: "Party changes" }),
    ).toHaveTextContent("Kim left the Party. Lime is free");
    expect(screen.queryByRole("listitem", { name: /Kim/ })).toBeNull();
  });

  it("has Leave party at the bottom, which leaves", async () => {
    const { sent } = await openPeople();
    const leave = screen.getByRole("button", { name: "Leave party" });
    act(() => {
      fireEvent.click(leave);
    });
    expect(sent).toContainEqual({ type: "leaveParty" });
  });

  it("disables Leave party while this member sits in the Line-up", async () => {
    const { sent } = await openPeople(
      partyOf([{ ...bo, singing: true }, lukas, kim, ada]),
    );
    const leave = screen.getByRole("button", { name: "Leave party" });
    expect(leave).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Take yourself off the Song first to leave"),
    ).toBeInTheDocument();
    act(() => {
      fireEvent.click(leave);
    });
    expect(sent.some((m) => m.type === "leaveParty")).toBe(false);
  });

  it("offers no New party and no Profile delete", async () => {
    await openPeople();
    expect(screen.queryByRole("button", { name: /New party/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});
