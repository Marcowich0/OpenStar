// The rules of the People tab and the Me sheet (v1 spec #49, "People tab",
// "Me sheet"), kept pure so they are tested for a given Party.

import type { Difficulty } from "../../generated/Difficulty";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PhoneId } from "../../generated/PhoneId";
import type { Profile } from "../../generated/Profile";
import type { Seat } from "../../generated/Seat";
import type { PaletteKey } from "../../theme/tokens";
import { memberLook, type MemberLook } from "../memberLook";

/**
 * What a row's end shows: the × held to remove the member, "singing" for a
 * member in the Line-up (who can't be removed), or nothing on this Phone's
 * own row.
 */
export type RowRemove = "hold" | "singing" | "none";

export interface PeopleRow {
  member: PartyMember;
  /** `null` until the Profiles load. */
  look: MemberLook | null;
  /** This Phone's own member ("me"). */
  isMe: boolean;
  guest: boolean;
  /** The favourite colour a Profile did not get tonight ("favourite <Colour> is taken"). */
  favouriteTaken: PaletteKey | null;
  remove: RowRemove;
}

/** One row per Party member, in the order they entered. */
export function peopleRows(
  members: readonly PartyMember[],
  me: PartyMemberId | null,
  profiles: readonly Profile[] | undefined,
): PeopleRow[] {
  return members.map((member) => {
    const isMe = member.memberId === me;
    const { identity } = member;
    const favourite =
      member.favouriteTaken && identity.kind === "profile"
        ? (profiles?.find((p) => p.id === identity.profileId)
            ?.favouriteColour ?? null)
        : null;
    return {
      member,
      look: memberLook(member, profiles),
      isMe,
      guest: identity.kind === "guest",
      favouriteTaken: favourite,
      remove: isMe ? "none" : member.singing ? "singing" : "hold",
    };
  });
}

/**
 * The Difficulty "My Difficulty for the next Song" shows: the member's seat
 * while they sit in the Line-up, otherwise a Guest's own or a Profile's
 * last one (`null` until the Profiles load).
 */
export function myDifficulty(
  member: PartyMember,
  profiles: readonly Profile[] | undefined,
  lineUpSeats: readonly Seat[] | null,
): Difficulty | null {
  const seat = lineUpSeats?.find((s) => s.memberId === member.memberId);
  if (seat) return seat.difficulty;
  const { identity } = member;
  switch (identity.kind) {
    case "guest":
      return identity.difficulty;
    case "profile":
      return (
        profiles?.find((p) => p.id === identity.profileId)?.lastDifficulty ??
        null
      );
  }
}

/**
 * The Me sheet's "Admin" link opens `/admin` in the same tab, so it hides
 * while this Phone is the Mic of a seat in a playing Song: leaving the page
 * would lose the mic mid-Song.
 */
export function showsAdminLink(
  phoneId: PhoneId,
  playing: readonly Seat[] | null,
): boolean {
  return !(
    playing?.some(
      (s) => s.mic?.kind === "phone" && s.mic.phoneId === phoneId,
    ) ?? false
  );
}
