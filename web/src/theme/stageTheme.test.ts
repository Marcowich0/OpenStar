// Every screen (Stage, Phone, Admin) follows the Stage's theme: the Stage
// options in the query cache, which the `stageOptions` change notice on the
// WebSocket refetches. Until they load, the theme this browser last showed.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultStageOptions,
  stageOptionsKey,
} from "../stageOptions/stageOptions";
import type { Theme } from "../generated/Theme";
import { followStageTheme } from "./stageTheme";

const root = document.documentElement;

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    items,
  };
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
}

const withTheme = (theme: Theme) => ({ ...defaultStageOptions(), theme });

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
});

describe("followStageTheme", () => {
  it("shows the theme of the loaded Stage options", () => {
    const queryClient = client();
    queryClient.setQueryData(stageOptionsKey, withTheme("bubblePopNight"));
    stop = followStageTheme(queryClient, memoryStorage());
    expect(root.dataset.theme).toBe("bubblePopNight");
  });

  it("follows a change without a reload", () => {
    const queryClient = client();
    queryClient.setQueryData(stageOptionsKey, withTheme("bubblePop"));
    stop = followStageTheme(queryClient, memoryStorage());
    queryClient.setQueryData(stageOptionsKey, withTheme("bubblePopNight"));
    expect(root.dataset.theme).toBe("bubblePopNight");
    queryClient.setQueryData(stageOptionsKey, withTheme("bubblePop"));
    expect(root.dataset.theme).toBe("bubblePop");
  });

  it("shows the theme this browser last showed until the options load", () => {
    const first = memoryStorage();
    const queryClient = client();
    queryClient.setQueryData(stageOptionsKey, withTheme("bubblePopNight"));
    followStageTheme(queryClient, first)();

    root.removeAttribute("data-theme");
    stop = followStageTheme(
      client(),
      memoryStorage(Object.fromEntries(first.items)),
    );
    expect(root.dataset.theme).toBe("bubblePopNight");
  });

  it("ignores a remembered value that is no theme", () => {
    stop = followStageTheme(
      client(),
      memoryStorage({ "openstar.theme": "pink" }),
    );
    expect(root.dataset.theme).toBe("bubblePop");
  });
});
