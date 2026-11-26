import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SongSummary } from "../../generated/SongSummary";
import { TimingEditorLink } from "./TimingEditorLink";

const song = {
  id: 12,
  path: "A - B/b.txt",
  artist: "Abba",
  title: "Waterloo",
  duet: false,
  identity: {
    kind: "artistTitle",
    artist: "Abba",
    title: "Waterloo",
    duet: false,
  },
  lengthSeconds: 180,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "cherry",
  topHighScore: null,
  year: null,
} satisfies SongSummary;

describe("the Songs section's way into the Timing editor", () => {
  it("links each Song to its Timing editor", async () => {
    const root = createRootRoute({
      component: () => <TimingEditorLink song={song} />,
    });
    const timing = createRoute({
      getParentRoute: () => root,
      path: "/admin/songs/$song/timing",
    });
    const router = createRouter({
      routeTree: root.addChildren([timing]),
      history: createMemoryHistory(),
    });
    render(<RouterProvider router={router} />);
    await act(async () => {
      await router.load();
    });

    expect(
      screen.getByRole("link", { name: "Timing of Waterloo" }),
    ).toHaveAttribute("href", "/admin/songs/12/timing");
  });
});
