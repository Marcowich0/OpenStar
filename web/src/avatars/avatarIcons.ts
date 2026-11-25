// The 24 built-in avatar icons (spec #48 owns the set and its keys, generated
// as `AvatarKey` from `crates/protocol`). Each is a bundled SVG file in this
// folder, drawn on a 64 × 64 grid with no colours of its own: `#glyph` is
// the silhouette, which `Avatar` (ui/Avatar.tsx) outlines in ink and fills
// white, and `#detail` holds the ink marks drawn on top (eyes, veins). The
// files are referenced through `<use>`, so the theme tokens colour them.

import type { AvatarKey } from "../generated/AvatarKey";

import star from "./star.svg";
import heart from "./heart.svg";
import moon from "./moon.svg";
import bolt from "./bolt.svg";
import note from "./note.svg";
import crown from "./crown.svg";
import drop from "./drop.svg";
import leaf from "./leaf.svg";
import diamond from "./diamond.svg";
import cloud from "./cloud.svg";
import flame from "./flame.svg";
import ghost from "./ghost.svg";
import sun from "./sun.svg";
import planet from "./planet.svg";
import rocket from "./rocket.svg";
import cat from "./cat.svg";
import fish from "./fish.svg";
import flower from "./flower.svg";
import mushroom from "./mushroom.svg";
import apple from "./apple.svg";
import guitar from "./guitar.svg";
import headphones from "./headphones.svg";
import rainbow from "./rainbow.svg";
import butterfly from "./butterfly.svg";

/**
 * Every avatar key's file URL. `satisfies` makes the map exhaustive: a key
 * the protocol adds or removes fails `tsc` here until its icon is drawn.
 */
const AVATAR_ICON_URLS = {
  star,
  heart,
  moon,
  bolt,
  note,
  crown,
  drop,
  leaf,
  diamond,
  cloud,
  flame,
  ghost,
  sun,
  planet,
  rocket,
  cat,
  fish,
  flower,
  mushroom,
  apple,
  guitar,
  headphones,
  rainbow,
  butterfly,
} as const satisfies Record<AvatarKey, string>;

/** The avatar keys, in the order of the built-in set (for pickers). */
export const AVATAR_KEYS = Object.keys(AVATAR_ICON_URLS) as AvatarKey[];

/** The part of an icon file `Avatar` draws. */
export type AvatarIconPart = "glyph" | "detail";

/** A `<use href>` reference to one part of an avatar icon. */
export function avatarIconUrl(key: AvatarKey, part: AvatarIconPart): string {
  return `${AVATAR_ICON_URLS[key]}#${part}`;
}
