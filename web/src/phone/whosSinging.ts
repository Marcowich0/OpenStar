import type { PaletteKey } from "../generated/PaletteKey";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";

/** One Profile in the "Who's singing?" grid. */
export interface WhosSingingEntry {
  profile: Profile;
  /** Already a Party member. */
  here: boolean;
  /** Its Party colour when here, its favourite colour otherwise. */
  colour: PaletteKey;
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * Every Profile for the grid: the most recently sung first, then those that
 * have never sung, by name. Each is marked "here" when already a Party member.
 */
export function whosSinging(
  profiles: readonly Profile[],
  members: readonly PartyMember[],
): WhosSingingEntry[] {
  const colourOf = new Map<number, PaletteKey>();
  for (const member of members) {
    if (member.identity.kind === "profile")
      colourOf.set(member.identity.profileId, member.colour);
  }
  return [...profiles]
    .sort((a, b) => {
      if (a.lastSungAt !== null && b.lastSungAt !== null)
        return b.lastSungAt - a.lastSungAt;
      if (a.lastSungAt !== null) return -1;
      if (b.lastSungAt !== null) return 1;
      return byName.compare(a.name, b.name);
    })
    .map((profile) => {
      const partyColour = colourOf.get(profile.id);
      return {
        profile,
        here: partyColour !== undefined,
        colour: partyColour ?? profile.favouriteColour,
      };
    });
}
