import { describe, expect, it } from "vitest";

import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import type { PaletteKey } from "../theme/tokens";
import { colourChoices, formNameCheck, randomAvatar } from "./joinForm";

function member(
  memberId: number,
  colour: PaletteKey,
  guestName?: string,
): PartyMember {
  return {
    memberId,
    identity: guestName
      ? {
          kind: "guest",
          name: guestName,
          avatar: { kind: "builtIn", key: "star" },
          difficulty: "medium",
        }
      : { kind: "profile", profileId: memberId },
    colour,
    favouriteTaken: false,
    onPhone: true,
  };
}

const BO: Profile = {
  id: 2,
  name: "Bo",
  avatar: { kind: "builtIn", key: "star" },
  favouriteColour: "sky",
  lastDifficulty: "medium",
  createdAt: 0,
  lastSungAt: null,
};

describe("the form's colours", () => {
  it("offers all twelve in palette order, the first one preselected, in an empty Party", () => {
    const { choices, preselected } = colourChoices([]);
    expect(choices.map((c) => c.colour)).toEqual([
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
    expect(choices.every((c) => !c.held)).toBe(true);
    expect(preselected).toBe("cherry");
  });

  it("crosses out the colours held tonight and preselects the first free one", () => {
    const { choices, preselected } = colourChoices([
      member(1, "cherry"),
      member(2, "navy", "Lukas"),
      member(3, "sky"),
    ]);
    expect(choices.filter((c) => c.held).map((c) => c.colour)).toEqual([
      "cherry",
      "sky",
      "navy",
    ]);
    expect(preselected).toBe("cocoa");
  });

  it("preselects nothing when all twelve are held", () => {
    const keys: PaletteKey[] = [
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
    ];
    const { choices, preselected } = colourChoices(
      keys.map((key, i) => member(i + 1, key)),
    );
    expect(choices.every((c) => c.held)).toBe(true);
    expect(preselected).toBeNull();
  });
});

describe("the form's name check", () => {
  const members = [member(1, "cherry"), member(7, "lime", "Lukas")];

  it("is empty until a name is typed", () => {
    expect(formNameCheck("   ", [BO], members)).toEqual({ kind: "empty" });
  });

  it("offers the Profile whose name it is, ignoring case and surrounding spaces", () => {
    expect(formNameCheck("  bO ", [BO], members)).toEqual({
      kind: "profile",
      profile: BO,
    });
  });

  it("blocks a Guest name already used tonight, ignoring case and spaces", () => {
    expect(formNameCheck(" LUKAS", [BO], members)).toEqual({
      kind: "takenTonight",
    });
  });

  it("lets any other name through", () => {
    expect(formNameCheck("Mia", [BO], members)).toEqual({ kind: "free" });
  });
});

describe("the form's picture", () => {
  it("is one of the 24 built-in avatars, picked by the random source", () => {
    expect(randomAvatar(() => 0)).toEqual({ kind: "builtIn", key: "star" });
    const last = randomAvatar(() => 0.9999);
    expect(last.kind).toBe("builtIn");
    expect(last).not.toEqual(randomAvatar(() => 0));
  });
});
