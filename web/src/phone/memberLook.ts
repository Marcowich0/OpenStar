import type { Avatar } from "../generated/Avatar";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";

/** How a Party member is shown: their name and avatar. */
export interface MemberLook {
  name: string;
  avatar: Avatar;
}

/**
 * A Party member's name and avatar. A Guest carries its own; the snapshot
 * holds a Profile member's id only, so its look comes from the Profiles list
 * (`null` until it loads).
 */
export function memberLook(
  member: PartyMember,
  profiles: readonly Profile[] | undefined,
): MemberLook | null {
  const { identity } = member;
  switch (identity.kind) {
    case "profile": {
      const profile = profiles?.find((p) => p.id === identity.profileId);
      return profile ? { name: profile.name, avatar: profile.avatar } : null;
    }
    case "guest":
      return { name: identity.name, avatar: identity.avatar };
  }
}
