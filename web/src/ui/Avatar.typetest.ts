// Type-level checks: an avatar takes a palette key, never a colour value, and
// one of the 24 avatar keys.

import type { AvatarProps } from "./Avatar";

export const takesAPaletteKey: AvatarProps = {
  name: "Mia",
  avatar: { kind: "builtIn", key: "cat" },
  colour: "grape",
  size: 46,
};

export const refusesAColourValue: AvatarProps = {
  ...takesAPaletteKey,
  // @ts-expect-error a colour value is not a palette key
  colour: "gold",
};

export const refusesAnUnknownIcon: AvatarProps = {
  ...takesAPaletteKey,
  // @ts-expect-error not one of the 24 avatar keys
  avatar: { kind: "builtIn", key: "dog" },
};
