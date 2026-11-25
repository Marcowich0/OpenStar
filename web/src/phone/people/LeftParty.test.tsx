import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  partyOf,
  profile,
  profileMember,
  profilesFetch,
  renderJoinedPhone,
} from "./testPhone";

const PROFILES = [profile(7, "Bo"), profile(8, "Lukas")];
const bo = profileMember(1, 7, "cherry");
const lukas = profileMember(2, 8, "sky");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(profilesFetch(PROFILES)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Phone whose member is no longer in the Party", () => {
  it("shows You left the Party when its member was removed", () => {
    const { server, change } = renderJoinedPhone(partyOf([bo, lukas]));
    server({ type: "leftParty" });
    change(
      { kind: "member", memberId: 2 },
      {
        code: "memberLeft",
        params: {
          memberId: 1,
          name: "Bo",
          avatar: { kind: "builtIn", key: "cat" },
          colour: "cherry",
        },
      },
      partyOf([lukas]),
    );
    expect(
      screen.getByRole("heading", { name: "You left the Party" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your colour went back to the pool/),
    ).toBeInTheDocument();
  });

  it("shows it when a new Party replaced this one", () => {
    const { server } = renderJoinedPhone(partyOf([bo, lukas]));
    server(
      { type: "leftParty" },
      {
        type: "partyChanged",
        party: { ...partyOf([]), partyId: "p2", joinCode: "1357" },
        change: {
          actor: { kind: "stage" },
          event: { code: "partyStarted", params: { joinCode: "1357" } },
        },
      },
    );
    expect(
      screen.getByRole("heading", { name: "You left the Party" }),
    ).toBeInTheDocument();
  });

  it("leads to the Join code pad with Join again", () => {
    const { server } = renderJoinedPhone(partyOf([bo, lukas]));
    server({ type: "leftParty" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Join again" }));
    });
    expect(
      screen.getByRole("heading", { name: "Join the Party" }),
    ).toBeInTheDocument();
  });

  it("never shows it to a Phone that simply has not joined", () => {
    renderJoinedPhone(partyOf([lukas]), { memberId: null });
    expect(screen.queryByText("You left the Party")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Join the Party" }),
    ).toBeInTheDocument();
  });
});
