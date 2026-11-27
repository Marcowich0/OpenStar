// The Stage tab's cards besides the waiting Line-up (#160): the playing or
// paused Song, the results, the empty Queue, and the OpenStar volume in
// every state. The waiting Line-up's card is tested in StageTab.test.tsx.

import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { StageTab } from "../stage/StageTab";
import {
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "../stage/testParty";

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Bo and Jonas sing Valerie (Request 1); `paused` after a Pause. */
const playing = (paused = false): PartySnapshot => ({
  ...PARTY,
  lineUp: { ...LINE_UP, canStart: false },
  playing: { requestId: 1, songId: 40, paused },
});

/** The Stage shows Valerie's results; `queue` is what is left. */
const results = (queue: PartySnapshot["queue"]): PartySnapshot => ({
  ...PARTY,
  queue,
  head: null,
  lineUp: null,
  results: { requestId: 1, songId: 40, ended: "played", players: [] },
});

const emptyQueue: PartySnapshot = {
  ...PARTY,
  queue: [],
  head: null,
  lineUp: null,
};

const islands = {
  requestId: 2,
  kind: "song" as const,
  songId: 41,
  requestedPlayers: [],
  adder: 1,
};

function renderTab(party: PartySnapshot) {
  return renderWithParty(party, (store) => (
    <StageTab store={store} myPhoneId={MY_PHONE} />
  ));
}

describe("the Stage tab while a Song plays", () => {
  it("shows the cover, the title and the Players", async () => {
    renderTab(playing());
    const card = await screen.findByTestId("playing-card");
    expect(within(card).getByText("Playing now")).toBeInTheDocument();
    expect(await within(card).findByText("Valerie")).toBeInTheDocument();
    expect(await within(card).findByText("Bo, Jonas")).toBeInTheDocument();
    expect(within(card).getByTestId("cover")).toBeInTheDocument();
    expect(screen.queryByText("Up next: who sings?")).toBeNull();
  });

  it("pauses with a plain tap, and resumes the paused Song", async () => {
    const { sent, server } = renderTab(playing());
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(sent).toEqual([
      { type: "controlSong", requestId: 1, control: "pause" },
    ]);

    server({
      type: "partyChanged",
      party: playing(true),
      change: {
        actor: { kind: "member", memberId: 1 },
        event: {
          code: "songPaused",
          params: { requestId: 1, songId: 40, title: "Valerie" },
        },
      },
    });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(sent.at(-1)).toEqual({
      type: "controlSong",
      requestId: 1,
      control: "resume",
    });
  });

  it("has Restart, Skip and End as hold buttons, with the hint", async () => {
    const { sent } = renderTab(playing());
    expect(
      await screen.findByText("Hold Restart, Skip or End for a moment"),
    ).toBeInTheDocument();
    vi.useFakeTimers();
    for (const [name, control] of [
      ["Restart", "restart"],
      ["Skip", "skip"],
      ["End", "end"],
    ] as const) {
      const button = screen.getByRole("button", { name });
      // A plain tap does nothing: a pocket tap never skips a Song.
      act(() => {
        fireEvent.click(button);
      });
      expect(sent.some((m) => "control" in m && m.control === control)).toBe(
        false,
      );
      act(() => {
        fireEvent.pointerDown(button);
        vi.advanceTimersByTime(HOLD_DURATION_MS);
        fireEvent.pointerUp(button);
      });
      expect(sent.at(-1)).toEqual({
        type: "controlSong",
        requestId: 1,
        control,
      });
    }
  });

  it("shows the progress from the Stage's last position report", async () => {
    const { server } = renderTab(playing(true));
    await screen.findByTestId("playing-card");
    server({
      type: "songProgress",
      progress: {
        requestId: 1,
        positionSeconds: 65,
        rate: 0,
        lengthSeconds: 200,
        introEndSeconds: null,
        ageMs: 4000,
      },
    });
    const bar = screen.getByRole("progressbar", { name: "Song progress" });
    // Paused: the reported position holds, however old the report.
    expect(bar).toHaveAttribute("aria-valuenow", "33");
    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByText("3:20")).toBeInTheDocument();
  });

  it("moves the progress on between reports while the Song plays", async () => {
    // The page's clock and the card's tick are the test's: a loaded machine
    // cannot let 1:59.8 pass before the first look.
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "performance"],
    });
    const { server } = renderTab(playing());
    await screen.findByTestId("playing-card");
    // Reported 2 s ago at 1:57.8: it is 1:59.8 now, and 2:00 a moment later.
    server({
      type: "songProgress",
      progress: {
        requestId: 1,
        positionSeconds: 117.8,
        rate: 1,
        lengthSeconds: 200,
        introEndSeconds: null,
        ageMs: 2000,
      },
    });
    expect(screen.getByText("1:59")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("2:00")).toBeInTheDocument();
  });

  it("offers Skip intro while the Intro plays, as a plain tap, until shortly before it ends", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "performance"],
    });
    const { sent, server } = renderTab(playing());
    await screen.findByTestId("playing-card");
    const progress = (rate: number, introEndSeconds: number | null) => {
      server({
        type: "songProgress",
        progress: {
          requestId: 1,
          positionSeconds: 4,
          rate,
          lengthSeconds: 200,
          introEndSeconds,
          ageMs: 0,
        },
      });
    };
    progress(1, null);
    expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();

    // Skip intro lands at 0:27, three seconds before the first Note.
    progress(1, 27);
    expect(screen.getByText("Singing in 0:26")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
    expect(sent.at(-1)).toEqual({
      type: "controlSong",
      requestId: 1,
      control: "skipIntro",
    });

    // Paused: nothing to skip until it runs again.
    progress(0, 27);
    expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
    progress(1, 27);
    act(() => {
      vi.advanceTimersByTime(22_000);
    });
    expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
  });
});

describe("the Stage tab on results", () => {
  it("shows “Results on the Stage”, the title and Next Song, which moves the Stage on", async () => {
    const { sent } = renderTab(results([islands]));
    const card = await screen.findByTestId("results-card");
    expect(within(card).getByText("Results on the Stage")).toBeInTheDocument();
    expect(await within(card).findByText("Valerie")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Next Song" }));
    expect(sent).toEqual([{ type: "closeResults" }]);
  });

  it("shows Done when the Queue holds nothing more", async () => {
    const { sent } = renderTab(results([]));
    const card = await screen.findByTestId("results-card");
    expect(
      within(card).queryByRole("button", { name: "Next Song" }),
    ).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    expect(sent).toEqual([{ type: "closeResults" }]);
  });
});

describe("the Stage tab with an empty Queue", () => {
  it("says the Stage is waiting for a Song", async () => {
    renderTab(emptyQueue);
    expect(await screen.findByText("The Stage is waiting")).toBeInTheDocument();
    expect(
      screen.getByText("The Queue is empty. Pick a song."),
    ).toBeInTheDocument();
  });
});

describe("the OpenStar volume on the Stage tab", () => {
  it.each([
    ["a waiting Line-up", PARTY],
    ["a playing Song", playing()],
    ["a paused Song", playing(true)],
    ["the results", results([])],
    ["an empty Queue", emptyQueue],
  ])("shows − and + around the value with %s", async (_, party) => {
    const { server } = renderTab(party);
    server({ type: "volume", volume: 80, stepped: false });
    const volume = await screen.findByRole("group", { name: "Volume" });
    expect(within(volume).getByText("80")).toBeInTheDocument();
    const buttons = within(volume).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Volume down",
      "Volume up",
    ]);
  });

  it("steps the Stage's one volume, with no Admin PIN, and shows the server's value", async () => {
    const { sent, server } = renderTab(playing());
    server({ type: "volume", volume: 80, stepped: false });
    const volume = await screen.findByRole("group", { name: "Volume" });
    fireEvent.click(within(volume).getByRole("button", { name: "Volume up" }));
    fireEvent.click(
      within(volume).getByRole("button", { name: "Volume down" }),
    );
    expect(sent).toEqual([
      { type: "stepVolume", step: "up" },
      { type: "stepVolume", step: "down" },
    ]);
    // Another Remote or the Stage's own + key stepped it.
    server({ type: "volume", volume: 85, stepped: true });
    expect(within(volume).getByText("85")).toBeInTheDocument();
  });

  it("cannot step past 0 or 100", async () => {
    const { server } = renderTab(emptyQueue);
    server({ type: "volume", volume: 100, stepped: false });
    const volume = await screen.findByRole("group", { name: "Volume" });
    expect(
      within(volume).getByRole("button", { name: "Volume up" }),
    ).toBeDisabled();
    server({ type: "volume", volume: 0, stepped: true });
    expect(
      within(volume).getByRole("button", { name: "Volume down" }),
    ).toBeDisabled();
    expect(
      within(volume).getByRole("button", { name: "Volume up" }),
    ).toBeEnabled();
  });

  it("waits for the Stage before it can step", async () => {
    renderTab(emptyQueue);
    const volume = await screen.findByRole("group", { name: "Volume" });
    expect(within(volume).getByText("–")).toBeInTheDocument();
    for (const button of within(volume).getAllByRole("button"))
      expect(button).toBeDisabled();
  });
});
