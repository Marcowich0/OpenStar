import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { songsQuery } from "../../../api/queries";
import { createQueryClient } from "../../../api/queryClient";
import type { ClientMessage } from "../../../generated/ClientMessage";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { SongResults } from "../../../generated/SongResults";
import type { SongSummary } from "../../../generated/SongSummary";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import { StageFrame } from "../../frame/StageFrame";
import { StageSoundsProvider } from "../../sound/StageSounds";
import { recordedSounds } from "../../sound/testSounds";
import { ResultsBody } from "./ResultsScene";
import { playerResult, songResults } from "./testResults";

const song = (id: number, title: string, artist: string): SongSummary => ({
  id,
  path: `${title}.txt`,
  artist,
  title,
  duet: false,
  identity: { kind: "artistTitle", artist, title, duet: false },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
});

const party = (
  results: SongResults,
  queuedSongs: number[] = [],
): PartySnapshot => ({
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [],
  phones: [],
  queue: queuedSongs.map((songId, index) => ({
    requestId: 2 + index,
    kind: "song",
    songId,
    requestedPlayers: [],
    adder: null,
  })),
  head: null,
  lineUp: null,
  playing: null,
  results,
  localMics: [],
});

function setup(snapshot: PartySnapshot) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const queries = createQueryClient();
  queries.setQueryData(songsQuery().queryKey, {
    songs: [song(10, "Islands", "Kiri"), song(20, "Wave", "Tide")],
    filters: {
      languages: [],
      genres: [],
      years: [],
      editions: [],
      creators: [],
      duet: [],
      hasVideo: [],
      length: null,
    },
  });
  render(
    <QueryClientProvider client={queries}>
      <StageFrame store={store} />
    </QueryClientProvider>,
  );
  act(() => {
    handlers?.onConnection("open");
    handlers?.onMessage({
      type: "liveState",
      stageId: "main",
      party: snapshot,
      isStage: true,
    });
  });
  return { sent };
}

const bo = playerResult({
  memberId: 1,
  name: "Bo",
  colour: "sky",
  difficulty: "hard",
  total: 7583,
  notes: 6115,
  golden: 857,
  lineBonus: 611,
  rankTitleBand: 6,
  newHighScore: true,
});
const mia = playerResult({
  memberId: 2,
  name: "Mia",
  player: { kind: "guest", name: "Mia" },
  colour: "grape",
  total: 2400,
  notes: 2000,
  golden: 200,
  lineBonus: 200,
  place: 2,
  rankTitleBand: 1,
  micLost: true,
});

const bars = () =>
  within(screen.getByTestId("results-players")).getAllByRole("listitem");

describe("the results scene", () => {
  it("heads the screen with the Song's title and artist", () => {
    setup(party(songResults([bo, mia])));
    expect(
      screen.getByRole("heading", { level: 1, name: "Islands" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Kiri")).toBeInTheDocument();
    expect(
      screen.queryByText("Ended early, so no high scores this time"),
    ).not.toBeInTheDocument();
  });

  it("replaces the artist with the banner when no Player finished", () => {
    setup(
      party(
        songResults(
          [
            { ...bo, unfinished: true, newHighScore: false },
            { ...mia, unfinished: true },
          ],
          { ended: "ended" },
        ),
      ),
    );
    expect(
      screen.getByText("Ended early, so no high scores this time"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Kiri")).not.toBeInTheDocument();
  });

  it("shows one bar per Player, ranked, with what the spec puts above and under it", () => {
    setup(party(songResults([bo, mia])));
    const [first, second] = bars();
    if (!first || !second) throw new Error("two bars");
    const one = within(first);
    expect(one.getByText("7583")).toBeInTheDocument();
    expect(one.getByText("Rock Star")).toBeInTheDocument();
    expect(one.getByRole("img", { name: "Bo" })).toBeInTheDocument();
    expect(one.getByText("Place 1")).toBeInTheDocument();
    expect(one.getByText("Bo")).toBeInTheDocument();
    expect(one.getByText("Hard")).toBeInTheDocument();
    expect(one.getByText("6115 + 857 + 611")).toBeInTheDocument();
    expect(one.getByText("New high score!")).toBeInTheDocument();
    expect(one.queryByText("Guest")).not.toBeInTheDocument();
    expect(one.queryByText("mic lost for part")).not.toBeInTheDocument();

    const two = within(second);
    expect(two.getByText("Hummingbird")).toBeInTheDocument();
    expect(two.getByText("Guest")).toBeInTheDocument();
    expect(two.getByText("mic lost for part")).toBeInTheDocument();
    expect(two.queryByText("New high score!")).not.toBeInTheDocument();
  });

  it("names the Voice in a duet", () => {
    setup(
      party(
        songResults([
          { ...bo, voice: 0 },
          { ...mia, voice: 1 },
        ]),
      ),
    );
    expect(
      within(bars()[0] as HTMLElement).getByText("Voice 1"),
    ).toBeInTheDocument();
    expect(
      within(bars()[1] as HTMLElement).getByText("Voice 2"),
    ).toBeInTheDocument();
  });

  it("stamps an unfinished Player's bar and gives it no sticker", () => {
    setup(
      party(
        songResults([bo, { ...mia, unfinished: true, newHighScore: true }]),
      ),
    );
    const [first, second] = bars();
    expect(
      within(first as HTMLElement).queryByText("unfinished"),
    ).not.toBeInTheDocument();
    expect(
      within(second as HTMLElement).getByText("unfinished"),
    ).toBeInTheDocument();
    expect(
      within(second as HTMLElement).queryByText("New high score!"),
    ).not.toBeInTheDocument();
  });

  it("has a legend of the three parts", () => {
    setup(party(songResults([bo])));
    const legend = within(
      screen.getByRole("list", { name: "What the bars are made of" }),
    );
    expect(legend.getAllByRole("listitem").map((i) => i.textContent)).toEqual([
      "Notes",
      "Golden",
      "Line bonus",
    ]);
  });

  it("leads on with Next: <Song>, focused, which closes the results", () => {
    const { sent } = setup(party(songResults([bo]), [20, 10]));
    const next = screen.getByRole("button", { name: "Next: Wave" });
    expect(next).toHaveFocus();
    act(() => {
      fireEvent.click(next);
    });
    expect(sent).toContainEqual({ type: "closeResults" });
  });

  it("says Done with an empty Queue, which also closes the results", () => {
    const { sent } = setup(party(songResults([bo])));
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toHaveFocus();
    act(() => {
      fireEvent.click(done);
    });
    expect(sent).toContainEqual({ type: "closeResults" });
  });

  it("shows no Join code", () => {
    setup(party(songResults([bo])));
    expect(screen.queryByText(/4821/)).not.toBeInTheDocument();
  });
});

describe("the results scene's sounds (ticket 262)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBody(results: SongResults) {
    vi.useFakeTimers();
    const store = createLiveStore(() => ({
      send: () => true,
      close: () => {},
    }));
    const recorded = recordedSounds();
    const view = render(
      <StageSoundsProvider store={store} sounds={recorded.sounds}>
        <ResultsBody
          results={results}
          song={null}
          next={null}
          onNext={() => {}}
        />
      </StageSoundsProvider>,
    );
    const at = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    return { played: recorded.played, at, view };
  }

  it("rises with the bars, plays the fanfare when they land and the high score with the sticker", () => {
    // Bo has the sticker: his bar grows first, so it pops 1.1 s + 0.9 s in.
    const { played, at } = renderBody(songResults([bo, mia]));
    at(0);
    expect(played).toEqual(["resultsRise"]);
    at(1249); // Mia's bar starts 150 ms in and grows for 1.1 s
    expect(played).toEqual(["resultsRise"]);
    at(1);
    expect(played).toEqual(["resultsRise", "fanfare"]);
    at(750);
    expect(played).toEqual(["resultsRise", "fanfare", "highScore"]);
    at(10_000);
    expect(played).toEqual(["resultsRise", "fanfare", "highScore"]);
  });

  it("plays no high score without a sticker", () => {
    const { played, at } = renderBody(songResults([mia]));
    at(10_000);
    expect(played).toEqual(["resultsRise", "fanfare"]);
  });

  it("stops the sounds still to come when the results close", () => {
    const { played, at, view } = renderBody(songResults([bo, mia]));
    at(500);
    view.unmount();
    at(10_000);
    expect(played).toEqual(["resultsRise"]);
  });
});
