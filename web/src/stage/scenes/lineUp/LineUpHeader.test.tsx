import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SongSummary } from "../../../generated/SongSummary";
import { LineUpHeader } from "./LineUpHeader";

// The Line-up's header (#247): a long title and artist stay on one line each
// and shorten with "…", but the page still holds them in full. jsdom has no
// layout, so `e2e/tests/line-up-title.spec.ts` checks the bounding boxes
// against the Stage menu and the back pill in Chromium.

/** 120 characters that start with `start` and end in a full stop. */
const long = (start: string) =>
  `${`${start}${" la".repeat(60)}`.slice(0, 119)}.`;
const LONG_TITLE = long("A Very Long Placeholder Title");
const LONG_ARTIST = long("The Placeholder Band and Friends");

const song: SongSummary = {
  id: 1,
  path: "long.txt",
  artist: LONG_ARTIST,
  title: LONG_TITLE,
  duet: false,
  identity: {
    kind: "artistTitle",
    artist: LONG_ARTIST,
    title: LONG_TITLE,
    duet: false,
  },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
};

describe("LineUpHeader", () => {
  it("holds a 120-character title and artist in full, each on one line with …", () => {
    expect(LONG_TITLE).toHaveLength(120);
    expect(LONG_ARTIST).toHaveLength(120);
    render(<LineUpHeader song={song} duet={false} />);

    const title = screen.getByRole("heading", { level: 1, name: LONG_TITLE });
    expect(title).toHaveAttribute("title", LONG_TITLE);
    expect(title).toHaveClass("truncate");

    const artist = screen.getByText(LONG_ARTIST);
    expect(artist).toHaveAttribute("title", LONG_ARTIST);
    expect(artist).toHaveClass("truncate");
  });

  it("names a duet's artist in full with its duet mark", () => {
    render(<LineUpHeader song={{ ...song, duet: true }} duet />);
    const artist = screen.getByText(`${LONG_ARTIST} · duet`);
    expect(artist).toHaveAttribute("title", `${LONG_ARTIST} · duet`);
  });

  it("shows an empty header while the Song has not loaded", () => {
    render(<LineUpHeader song={undefined} duet={false} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("");
  });
});
