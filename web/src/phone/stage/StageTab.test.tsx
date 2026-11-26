import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LineUp } from "../../generated/LineUp";
import { SEATS } from "../../live/seats";
import { StageTab } from "./StageTab";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
  renderWithParty,
  stubFetch,
} from "./testParty";

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTab(lineUp: LineUp | null = LINE_UP) {
  return renderWithParty({ ...PARTY, lineUp }, (store) => (
    <StageTab store={store} myPhoneId={MY_PHONE} />
  ));
}

const seatRow = (name: string) =>
  screen.findByRole("button", { name: new RegExp(`^${name}`) });

describe("the Stage tab while a Line-up waits", () => {
  it("shows “Up next: who sings?” with the Song's cover and title", async () => {
    renderTab();
    expect(await screen.findByText("Up next: who sings?")).toBeInTheDocument();
    expect(await screen.findByText("Valerie")).toBeInTheDocument();
    expect(screen.getByTestId("cover")).toBeInTheDocument();
  });

  it("shows one row per seat with name, Mic and Difficulty", async () => {
    renderTab();
    expect(await seatRow("Bo")).toHaveTextContent("This phone · Medium");
    expect(await seatRow("Jonas")).toHaveTextContent("Red mic · Hard");
    expect(screen.queryByText(/Voice/)).toBeNull();
  });

  it("shows the Voice in a duet and a “no mic” tag on a seat without one", async () => {
    renderTab({
      ...LINE_UP,
      duet: true,
      seats: [
        { ...BO_SEAT, voice: "p2" },
        { ...JONAS_SEAT, mic: null },
      ],
    });
    expect(await seatRow("Bo")).toHaveTextContent(
      "This phone · Voice 2 · Medium",
    );
    const jonas = await seatRow("Jonas");
    expect(within(jonas).getByText("no mic")).toBeInTheDocument();
  });

  it("shows no level meter on a seat row", async () => {
    renderTab();
    await seatRow("Bo");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("opens the seat sheet when a seat is tapped", async () => {
    renderTab();
    fireEvent.click(await seatRow("Jonas"));
    expect(
      await screen.findByRole("dialog", { name: "Jonas" }),
    ).toBeInTheDocument();
  });

  it("shows the server's warnings inline", async () => {
    renderTab({
      ...LINE_UP,
      canStart: false,
      warnings: [
        { code: "noMic", params: { memberId: 2 } },
        { code: "micBlocked", params: { memberId: 1 } },
        { code: "duetNeedsVoice", params: { voice: "p2" } },
      ],
    });
    expect(await screen.findByText("Jonas has no mic")).toBeInTheDocument();
    expect(await screen.findByText("Bo's mic is blocked")).toBeInTheDocument();
    expect(
      screen.getByText("A duet needs someone on Voice 2"),
    ).toBeInTheDocument();
  });

  it("adds a singer while seats are free and opens their sheet", async () => {
    const { sent, lineUpChanged } = renderTab();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a singer" }),
    );
    // The first Party member not seated yet: Sara.
    expect(sent.at(-1)).toEqual({
      type: "editLineUp",
      requestId: 1,
      edit: { kind: "addSeat", who: { kind: "member", memberId: 3 } },
    });
    lineUpChanged({
      ...LINE_UP,
      seats: [
        ...LINE_UP.seats,
        { memberId: 3, mic: null, voice: "p1", difficulty: "medium" },
      ],
    });
    expect(
      await screen.findByRole("dialog", { name: "Sara" }),
    ).toBeInTheDocument();
  });

  it("offers no “Add a singer” once every seat is filled", async () => {
    const seats = Array.from({ length: SEATS }, (_, i) => ({
      ...BO_SEAT,
      memberId: i + 1,
      mic: null,
    }));
    renderTab({ ...LINE_UP, seats });
    await seatRow("Bo");
    expect(screen.queryByRole("button", { name: "Add a singer" })).toBeNull();
  });

  it("keeps Start disabled until the server reports the Line-up valid", async () => {
    const { sent, lineUpChanged } = renderTab({ ...LINE_UP, canStart: false });
    const start = await screen.findByRole("button", { name: "Start" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(start);
    expect(sent.some((m) => m.type === "controlSong")).toBe(false);

    lineUpChanged(LINE_UP);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sent.at(-1)).toEqual({
      type: "controlSong",
      requestId: 1,
      control: "start",
    });
  });
});

describe("the Stage tab without a waiting Line-up", () => {
  it("shows no Line-up", async () => {
    renderWithParty(
      { ...PARTY, head: null, lineUp: null, queue: [] },
      (store) => <StageTab store={store} myPhoneId={MY_PHONE} />,
    );
    expect(await screen.findByText("On the Stage")).toBeInTheDocument();
    expect(screen.queryByText("Up next: who sings?")).toBeNull();
  });
});

describe("the Stage tab while the results show", () => {
  const bo = {
    memberId: 1,
    player: { kind: "profile" as const, profileId: 7 },
    name: "Bo",
    avatar: { kind: "builtIn" as const, key: "star" as const },
    colour: "cherry" as const,
    mic: BO_SEAT.mic,
    voice: null,
    difficulty: "medium" as const,
    total: 6115,
    notes: 5000,
    golden: 504,
    lineBonus: 611,
    place: 1,
    rankTitleBand: 4,
    newHighScore: true,
    micLost: false,
    unfinished: false,
  };

  function renderResults(players: (typeof bo)[]) {
    return renderWithParty(
      {
        ...PARTY,
        head: null,
        lineUp: null,
        queue: [],
        results: { requestId: 1, songId: 40, ended: "played", players },
      },
      (store) => <StageTab store={store} myPhoneId={MY_PHONE} />,
    );
  }

  it("shows this Phone's own Player's Score and its new high score", async () => {
    renderResults([
      { ...bo, memberId: 2, mic: JONAS_SEAT.mic, total: 9000 },
      bo,
    ]);
    expect(
      within(await screen.findByTestId("results-card")).getByText(
        "Results on the Stage",
      ),
    ).toBeInTheDocument();
    const card = await screen.findByTestId("my-result");
    expect(within(card).getByText("Your Score: 6,115")).toBeInTheDocument();
    expect(within(card).getByText("New high score!")).toBeInTheDocument();
    // The Rank title, from the same strings as the Stage's results.
    expect(within(card).getByText("Crowd Pleaser")).toBeInTheDocument();
    expect(within(card).queryByText("Ended early")).toBeNull();
  });

  it("marks an unfinished Score as ended early, and shows nothing for a Phone that sang nothing", async () => {
    renderResults([{ ...bo, unfinished: true, newHighScore: false }]);
    const card = await screen.findByTestId("my-result");
    expect(within(card).getByText("Ended early")).toBeInTheDocument();
    expect(within(card).queryByText("New high score!")).toBeNull();
  });

  it("shows no result card for a Phone that was nobody's Mic", async () => {
    renderResults([{ ...bo, mic: JONAS_SEAT.mic }]);
    expect(await screen.findByText("On the Stage")).toBeInTheDocument();
    expect(screen.queryByTestId("my-result")).toBeNull();
  });
});
