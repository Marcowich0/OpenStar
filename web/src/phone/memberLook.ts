import type { Avatar } from "../generated/Avatar";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";

/** How a Party member is shown: their name and avatar. */
export interface MemberLook {
  name: string;
  avatar: Avatar;
}

/**
 * A Party member's name and avatar. The snapshot holds a Profile member's
 * id only, so its look comes from the Profiles list; `null` until it loads.
 */
export function memberLook(
  member: PartyMember,
  profiles: readonly Profile[] | undefined,
): MemberLook | null {
  // Every member is a Profile so far; a Guest identity (#82) carries its
  // own name and avatar and fails tsc here until it is handled.
  const { profileId } = member.identity;
  const profile = profiles?.find((p) => p.id === profileId);
  return profile ? { name: profile.name, avatar: profile.avatar } : null;
}
