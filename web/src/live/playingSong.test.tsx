import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SongId } from "../generated/SongId";
import { initialLiveState } from "./liveState";
import { playingSong, useSongPlaying } from "./playingSong";
import { playingFeed } from "./playingSongTestKit";

function Probe({
  song,
  store,
}: {
  song: SongId;
  store: ReturnType<typeof playingFeed>;
}) {
  return <p data-testid="playing">{String(useSongPlaying(song, store))}</p>;
}

describe("the Song playing now", () => {
  it("is none before the server told the state", () => {
    expect(playingSong(initialLiveState)).toBeNull();
  });

  it("follows the Stage as Songs start and stop", () => {
    const feed = playingFeed();
    render(<Probe song={7} store={feed} />);
    const shown = () => screen.getByTestId("playing").textContent;
    expect(shown()).toBe("false");
    feed.play(7);
    expect(shown()).toBe("true");
    feed.play(8);
    expect(shown()).toBe("false");
    feed.play(null);
    expect(shown()).toBe("false");
  });
});
