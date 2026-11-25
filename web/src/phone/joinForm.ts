// The rules of the "New Profile" / "I'm a Guest" form (v1 spec #49, "Join
// flow: who's singing"), kept pure so they are tested for a given Party.

import { AVATAR_KEYS } from "../avatars/avatarIcons";
import type { Avatar } from "../generated/Avatar";
import type { PartyMember } from "../generated/PartyMember";
import type { Profile } from "../generated/Profile";
import { PALETTE_KEYS, type PaletteKey } from "../theme/tokens";

/** A name is at most 16 characters (`NAME_MAX_LENGTH` in `crates/protocol`). */
export const NAME_MAX_LENGTH = 16;

export interface ColourChoice {
  colour: PaletteKey;
  /** Held by a Party member tonight: crossed out, not selectable. */
  held: boolean;
}

/**
 * The twelve colours in palette order, those held tonight marked, and the
 * first free one, which the form preselects (`null` when all are held).
 */
export function colourChoices(members: readonly PartyMember[]): {
  choices: ColourChoice[];
  preselected: PaletteKey | null;
} {
  const held = new Set(members.map((m) => m.colour));
  const choices = PALETTE_KEYS.map((colour) => ({
    colour,
    held: held.has(colour),
  }));
  return {
    choices,
    preselected: choices.find((c) => !c.held)?.colour ?? null,
  };
}

/** The server's name key: case and surrounding spaces do not count. */
const nameKey = (name: string) => name.trim().toLowerCase();

export type FormNameCheck =
  | { kind: "empty" }
  | { kind: "free" }
  /** "Are you <name>?": it is this Profile's name. */
  | { kind: "profile"; profile: Profile }
  /** A Guest of tonight's Party has it: the form can't be sent. */
  | { kind: "takenTonight" };

/** Checks the typed name against the Profiles and tonight's Guests. */
export function formNameCheck(
  name: string,
  profiles: readonly Profile[],
  members: readonly PartyMember[],
): FormNameCheck {
  const key = nameKey(name);
  if (key === "") return { kind: "empty" };
  const profile = profiles.find((p) => nameKey(p.name) === key);
  if (profile) return { kind: "profile", profile };
  const guestHasIt = members.some(
    (m) => m.identity.kind === "guest" && nameKey(m.identity.name) === key,
  );
  return guestHasIt ? { kind: "takenTonight" } : { kind: "free" };
}

/** One of the built-in avatars, picked at random to prefill the form. */
export function randomAvatar(random: () => number = Math.random): Avatar {
  const index = Math.min(
    AVATAR_KEYS.length - 1,
    Math.floor(random() * AVATAR_KEYS.length),
  );
  return { kind: "builtIn", key: AVATAR_KEYS[index] ?? "star" };
}
