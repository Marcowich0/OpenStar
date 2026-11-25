import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import {
  guestMember,
  memoryStorage,
  partyOf,
  PHONE_ID,
  profile,
  profileMember,
  profilesFetch,
  renderJoinedPhone,
} from "./testPhone";

const PROFILES = [
  profile(7, "Bo", { favouriteColour: "cherry", lastDifficulty: "hard" }),
  profile(8, "Lukas", { favouriteColour: "sky" }),
  profile(9, "Ada", { favouriteColour: "teal" }),
];

const bo = profileMember(1, 7, "cherry");
const lukas = profileMember(2, 8, "sky");
const PARTY = partyOf([bo, lukas]);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(profilesFetch(PROFILES)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens the Me sheet from the avatar at the top right. */
async function openMe(snapshot: PartySnapshot = PARTY, memberId = 1) {
  const phone = renderJoinedPhone(snapshot, {
    memberId,
    // The Phone remembers Bo, so a plain join would offer "I'm Bo" first.
    storage: memoryStorage({
      "openstar.phoneId": PHONE_ID,
      "openstar.profileId": "7",
    }),
  });
  const avatar = await screen.findByRole("button", { name: /^Me/ });
  act(() => {
    fireEvent.click(avatar);
  });
  return { ...phone, sheet: screen.getByRole("dialog", { name: "Me" }) };
}

describe("the Me sheet", () => {
  it("opens from the avatar and shows who this Phone is", async () => {
    const { sheet } = await openMe();
    expect(within(sheet).getByRole("img", { name: "Bo" })).toBeInTheDocument();
    expect(within(sheet).getByText("Profile · Cherry")).toBeInTheDocument();
  });

  it("says Guest for tonight for a Guest", async () => {
    const { sheet } = await openMe(
      partyOf([bo, guestMember(3, "Kim", "lime")]),
      3,
    );
    expect(
      within(sheet).getByText("Guest for tonight · Lime"),
    ).toBeInTheDocument();
  });

  it("sets My Difficulty for the next Song", async () => {
    const { sheet, sent } = await openMe();
    const group = within(sheet).getByRole("radiogroup", {
      name: "My Difficulty for the next Song",
    });
    expect(within(group).getByRole("radio", { name: "Hard" })).toBeChecked();
    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "Easy" }));
    });
    expect(sent).toContainEqual({
      type: "setMyDifficulty",
      difficulty: "easy",
    });
  });

  it("goes back to the full Who's singing grid for someone else", async () => {
    const { sheet, sent, server } = await openMe();
    act(() => {
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: "Someone else is using this phone",
        }),
      );
    });
    const grid = screen.getByRole("list", { name: "Who's singing?" });
    act(() => {
      fireEvent.click(within(grid).getByRole("button", { name: /Ada/ }));
    });
    expect(sent).toContainEqual({
      type: "switchIdentity",
      joinAs: { kind: "profile", profileId: 9 },
    });
    expect(sent.some((m) => m.type === "leaveParty")).toBe(false);
    const ada = profileMember(3, 9, "teal");
    server(
      {
        type: "partyChanged",
        party: partyOf([bo, lukas, ada]),
        change: {
          actor: { kind: "member", memberId: 3 },
          event: {
            code: "memberJoined",
            params: { memberId: 3, name: "Ada", colour: "teal" },
          },
        },
      },
      { type: "phoneStatus", memberId: 3 },
    );
    expect(
      await screen.findByRole("button", { name: "Me: Ada" }),
    ).toBeInTheDocument();
  });

  it("can go back to the Remote from Who's singing", async () => {
    const { sheet } = await openMe();
    act(() => {
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: "Someone else is using this phone",
        }),
      );
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });
    expect(screen.getByRole("tab", { name: "People" })).toBeInTheDocument();
  });

  it("opens the join form filled in to change name, look or colour", async () => {
    const kim = guestMember(3, "Kim", "lime");
    const { sheet, sent, server } = await openMe(partyOf([bo, kim]), 3);
    act(() => {
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: "Change name, look or colour",
        }),
      );
    });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Kim");
    const colours = within(screen.getByRole("radiogroup", { name: /Colour/ }));
    expect(colours.getByRole("radio", { name: "Lime" })).toBeChecked();
    expect(colours.getByRole("radio", { name: "Cherry" })).toBeDisabled();
    expect(colours.getByRole("radio", { name: "Teal" })).toBeEnabled();
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Kimmy" },
      });
      fireEvent.click(colours.getByRole("radio", { name: "Teal" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(sent).toContainEqual({
      type: "editMember",
      memberId: 3,
      edit: {
        name: "Kimmy",
        colour: "teal",
        avatar: { kind: "builtIn", key: "flame" },
      },
    });
    const kimmy = guestMember(3, "Kimmy", "teal");
    server({
      type: "partyChanged",
      party: partyOf([bo, kimmy]),
      change: {
        actor: { kind: "member", memberId: 3 },
        event: {
          code: "memberChanged",
          params: { memberId: 3, name: "Kimmy" },
        },
      },
    });
    expect(
      await screen.findByRole("button", { name: "Me: Kimmy" }),
    ).toBeInTheDocument();
  });

  it("has Leave party, disabled while this member is in the Line-up", async () => {
    const { sheet, sent } = await openMe(
      partyOf([{ ...bo, singing: true }, lukas]),
    );
    const leave = within(sheet).getByRole("button", { name: "Leave party" });
    expect(leave).toHaveAttribute("aria-disabled", "true");
    expect(
      within(sheet).getByText("Take yourself off the Song first to leave"),
    ).toBeInTheDocument();
    act(() => {
      fireEvent.click(leave);
    });
    expect(sent.some((m) => m.type === "leaveParty")).toBe(false);
  });

  it("leaves the Party from the sheet", async () => {
    const { sheet, sent } = await openMe();
    act(() => {
      fireEvent.click(
        within(sheet).getByRole("button", { name: "Leave party" }),
      );
    });
    expect(sent).toContainEqual({ type: "leaveParty" });
  });

  it("links to the Admin area in the same tab", async () => {
    const { sheet } = await openMe();
    const admin = within(sheet).getByRole("link", { name: "Admin" });
    expect(admin).toHaveAttribute("href", "/admin");
    expect(admin).not.toHaveAttribute("target");
  });
});
