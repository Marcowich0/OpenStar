import { describe, expect, it } from "vitest";

import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import { memberLook } from "./memberLook";

const base = {
  memberId: 1,
  colour: "sky",
  favouriteTaken: false,
  onPhone: true,
} as const;

const bo: Profile = {
  id: 7,
  name: "Bo",
  avatar: { kind: "builtIn", key: "moon" },
  favouriteColour: "cherry",
  lastDifficulty: "medium",
  createdAt: 0,
  lastSungAt: null,
};

describe("a Party member's look", () => {
  it("comes from the Profile for a Profile member", () => {
    const member: PartyMember = {
      ...base,
      identity: { kind: "profile", profileId: 7 },
    };
    expect(memberLook(member, [bo])).toEqual({ name: "Bo", avatar: bo.avatar });
    expect(memberLook(member, undefined)).toBeNull();
  });

  it("is the Guest's own for a Guest", () => {
    const member: PartyMember = {
      ...base,
      identity: {
        kind: "guest",
        name: "Lukas",
        avatar: { kind: "builtIn", key: "cat" },
        difficulty: "easy",
      },
    };
    expect(memberLook(member, [bo])).toEqual({
      name: "Lukas",
      avatar: { kind: "builtIn", key: "cat" },
    });
  });
});
