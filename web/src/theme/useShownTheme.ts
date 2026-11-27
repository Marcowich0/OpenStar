// The theme shown on this document, for a component that draws with a
// theme's non-CSS values (the sing screen's lane panels and lyric bar): it
// re-renders when the Stage's theme changes. Colours need none of this; they
// are CSS custom properties, which follow the theme by themselves.

import { useSyncExternalStore } from "react";

import type { Theme } from "../generated/Theme";
import { shownTheme, subscribeShownTheme } from "./themes";

export function useShownTheme(): Theme {
  return useSyncExternalStore(subscribeShownTheme, shownTheme);
}
