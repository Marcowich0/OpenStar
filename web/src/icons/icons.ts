// The interface icon names. The icons themselves are SVG files in this
// folder, put on the document as `--icon-<name>` custom properties by
// `icons.css`; `Icon` (ui/Icon.tsx) draws one by name.

export const ICON_NAMES = [
  "backspace",
  "close",
  "list",
  "lock",
  "music",
  "people",
  "tv",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** The `var(--icon-…)` reference for an icon's image. */
export function iconVar(name: IconName): string {
  return `var(--icon-${name})`;
}
