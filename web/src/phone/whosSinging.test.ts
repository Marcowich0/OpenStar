import { describe, expect, it } from "vitest";

import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import { whosSinging } from "./whosSinging";

function profile(id: number, name: string, lastSungAt: number | null): Profile {
  return {
    id,
    name,
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt,
  };
}

const member = (profileId: number, colour: "sky" | "navy"): PartyMember => ({
  memberId: profileId * 10,
  identity: { kind: "profile", profileId },
  colour,
  favouriteTaken: false,
  onPhone: true,
  singing: false,
});

describe("the Who's singing? grid", () => {
  it("puts the most recently sung first, then the never-sung by name", () => {
    const profiles = [
      profile(1, "zoe", null),
      profile(2, "Bo", 100),
      profile(3, "Ada", null),
      profile(4, "Lukas", 300),
      profile(5, "mia", null),
    ];

    expect(whosSinging(profiles, []).map((p) => p.profile.name)).toEqual([
      "Lukas",
      "Bo",
      "Ada",
      "mia",
      "zoe",
    ]);
  });

  it("marks Profiles already in the Party here, in their Party colour", () => {
    const profiles = [profile(1, "Ada", null), profile(2, "Bo", null)];

    const grid = whosSinging(profiles, [member(2, "navy")]);

    expect(grid).toEqual([
      { profile: profiles[0], here: false, colour: "cherry" },
      { profile: profiles[1], here: true, colour: "navy" },
    ]);
  });

  it("marks nobody here for a Guest in the Party", () => {
    const profiles = [profile(1, "Ada", null)];
    const guest: PartyMember = {
      memberId: 5,
      identity: {
        kind: "guest",
        name: "Ada",
        avatar: { kind: "builtIn", key: "cat" },
        difficulty: "easy",
      },
      colour: "sky",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    };

    expect(whosSinging(profiles, [guest])[0]?.here).toBe(false);
  });
});
