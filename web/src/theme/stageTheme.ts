// Every screen follows the Stage's theme (spec #243: "Phones follow the
// Stage's theme over the WebSocket"). The theme is a Stage option, so it
// travels as the options do: the `stageOptions` change notice on the
// WebSocket invalidates the cached options and every open browser, Stage,
// Phone or Admin, refetches them. One observer of that query, started once
// for the whole app, applies the theme at the document root.
//
// Until the options load, the theme this browser last showed, so a dark room
// does not flash Bubble Pop on a reload. That copy is a per-browser
// convenience in `localStorage`; storage that is missing or blocked shows
// Bubble Pop until the options arrive.

import { QueryObserver, type QueryClient } from "@tanstack/react-query";

import type { Theme } from "../generated/Theme";
import { stageOptionsQuery } from "../stageOptions/stageOptions";
import { applyTheme, DEFAULT_THEME, isTheme } from "./themes";

const KEY = "openstar.theme";

/** The part of `localStorage` the remembered theme needs. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function remembered(storage: ThemeStorage | null): Theme {
  try {
    const value = storage?.getItem(KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function remember(storage: ThemeStorage | null, theme: Theme): void {
  try {
    storage?.setItem(KEY, theme);
  } catch {
    // Not kept: the next reload shows Bubble Pop until the options load.
  }
}

/**
 * Applies the Stage's theme now and on every change of the cached Stage
 * options; returns the function that stops following.
 */
export function followStageTheme(
  queryClient: QueryClient,
  storage: ThemeStorage | null = browserStorage(),
): () => void {
  let shown: Theme | null = null;
  const show = (theme: Theme) => {
    if (theme === shown) return;
    shown = theme;
    applyTheme(theme);
    remember(storage, theme);
  };
  const observer = new QueryObserver(queryClient, stageOptionsQuery);
  const loaded = observer.getCurrentResult().data;
  if (loaded) show(loaded.theme);
  else applyTheme(remembered(storage));
  return observer.subscribe(({ data }) => {
    if (data) show(data.theme);
  });
}
