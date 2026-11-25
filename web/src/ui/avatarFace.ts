// What an avatar disc carries, as pure functions (v1 spec: Visual direction
// and Stage screens, #55, "Avatars and covers").

/** Below this diameter (px in the reference frame) the icon gives way to the initial. */
export const INITIAL_BELOW_PX = 32;

/** The icon from the built-in set, or the Party member's outlined initial. */
export type AvatarFace = "icon" | "initial";

/**
 * What a disc drawn `size` px wide in the reference frame shows: the initial
 * where it is smaller than 32 px (chips, small list markers), the icon from
 * 32 px up.
 */
export function avatarFace(size: number): AvatarFace {
  return size < INITIAL_BELOW_PX ? "initial" : "icon";
}

/** The first character (whole grapheme) of a name, upper-cased. */
export function initialOf(name: string): string {
  const graphemes = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(name.trim());
  const first = graphemes[Symbol.iterator]().next().value?.segment;
  return first?.toLocaleUpperCase() ?? "";
}
