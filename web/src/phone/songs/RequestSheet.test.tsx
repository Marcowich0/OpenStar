import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import type { ClientMessage } from "../../generated/ClientMessage";
import type { HighScoreTable } from "../../generated/HighScoreTable";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { Request } from "../../generated/Request";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { RequestSheet, type RequestSheetTarget } from "./RequestSheet";

const profile = (id: number, name: string): Profile => ({
  id,
  name,
  avatar: { kind: "builtIn", key: "cat" },
  favouriteColour: "cherry",
  lastDifficulty: "medium",
  createdAt: 0,
  lastSungAt: null,
});

const PROFILES = [profile(7, "Bo"), profile(8, "Jonas")];

/** A Song detail with only the fields the sheet reads. */
const detail = (id: number, title: string, voices: number) => ({
  id,
  song: {
    headers: { title, artist: "Amy Winehouse", year: 2006 },
    voices: Array.from({ length: voices }, () => ({ lines: [] })),
  },
  lengthSeconds: 233.4,
  preparing: false,
  media: { cover: null, background: null, tileColour: "teal" },
});

const SONGS: Record<number, unknown> = {
  40: detail(40, "Valerie", 1),
  41: detail(41, "Islands", 2),
};

const holder = (profileId: number, name: string) => ({
  profileId,
  name,
  avatar: { kind: "builtIn", key: "cat" } as const,
  favouriteColour: "cherry" as const,
});

const table = (
  voice: number,
  difficulty: HighScoreTable["difficulty"],
  entries: HighScoreTable["entries"] = [],
): HighScoreTable => ({ voice, difficulty, entries });

const HIGH_SCORES: Record<number, HighScoreTable[]> = {
  40: [
    table(0, "easy"),
    table(0, "medium", [
      {
        place: 1,
        holder: holder(7, "Bo"),
        total: 8120,
        olderTiming: false,
      },
      {
        place: 2,
        holder: holder(8, "Jonas"),
        total: 6400,
        olderTiming: true,
      },
    ]),
    table(0, "hard", [
      { place: 1, holder: holder(8, "Jonas"), total: 9050, olderTiming: false },
    ]),
  ],
  41: [
    table(0, "easy"),
    table(0, "medium", [
      { place: 1, holder: holder(7, "Bo"), total: 5000, olderTiming: false },
    ]),
    table(0, "hard"),
    table(1, "easy"),
    table(1, "medium", [
      { place: 1, holder: holder(8, "Jonas"), total: 7000, olderTiming: false },
    ]),
    table(1, "hard"),
  ],
};

const request = (
  requestId: number,
  songId: number,
  requestedPlayers: number[] = [],
): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers,
  adder: null,
});

/** Bo (member 1) uses this Phone; Jonas (member 2) another. */
const party: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "cherry",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
    {
      memberId: 2,
      identity: { kind: "profile", profileId: 8 },
      colour: "sky",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
  ],
  phones: [],
  queue: [request(1, 41), request(2, 41, [2])],
  head: 1,
  lineUp: null,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const path = new URL(input, "http://openstar.test").pathname;
      const scores = /^\/api\/songs\/(\d+)\/high-scores$/.exec(path);
      if (scores)
        return Promise.resolve(
          Response.json({ tables: HIGH_SCORES[Number(scores[1])] }),
        );
      const song = /^\/api\/songs\/(\d+)$/.exec(path);
      if (song) return Promise.resolve(Response.json(SONGS[Number(song[1])]));
      return Promise.resolve(Response.json(PROFILES));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The Request sheet on Bo's Phone. */
function renderSheet(target: RequestSheetTarget) {
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
  const server = (...messages: ServerMessage[]) => {
    act(() => {
      for (const message of messages) handlers?.onMessage(message);
    });
  };
  act(() => {
    handlers?.onConnection("open");
  });
  server(
    { type: "liveState", stageId: "main", party, isStage: false },
    { type: "phoneStatus", memberId: 1 },
  );
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RequestSheet store={store} target={target} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { sent, server, onClose };
}

const singer = (name: string) =>
  within(screen.getByRole("group", { name: /Who sings it\?/ })).getByRole(
    "button",
    { name: new RegExp(`^${name}`) },
  );

describe("the Request sheet", () => {
  it("shows the Song's cover, title, artist and tags", async () => {
    renderSheet({ kind: "add", songId: 40 });
    const sheet = await screen.findByRole("dialog", { name: "Valerie" });
    expect(within(sheet).getByTestId("cover")).toBeInTheDocument();
    expect(within(sheet).getByText("Amy Winehouse")).toBeInTheDocument();
    expect(within(sheet).getByText("2006")).toBeInTheDocument();
    expect(within(sheet).getByText("3:53")).toBeInTheDocument();
    // The top High score at any Difficulty.
    expect(await within(sheet).findByText("Best 9,050")).toBeInTheDocument();
    expect(within(sheet).queryByText("Duet")).toBeNull();
  });

  it("preselects this Phone's identity among the Party members", async () => {
    renderSheet({ kind: "add", songId: 40 });
    await screen.findByRole("dialog", { name: "Valerie" });
    expect(await screen.findByText(/Who sings it\?/)).toHaveTextContent(
      "Who sings it? (optional)",
    );
    expect(singer("Bo")).toHaveAttribute("aria-pressed", "true");
    expect(singer("Jonas")).toHaveAttribute("aria-pressed", "false");
  });

  it("adds the hint “a duet needs two” for a duet", async () => {
    renderSheet({ kind: "add", songId: 41 });
    const sheet = await screen.findByRole("dialog", { name: "Islands" });
    expect(within(sheet).getByText("Duet")).toBeInTheDocument();
    expect(within(sheet).getByText(/Who sings it\?/)).toHaveTextContent(
      "Who sings it? (optional, a duet needs two)",
    );
  });

  it("says how many Requests are ahead", async () => {
    renderSheet({ kind: "add", songId: 40 });
    expect(await screen.findByText("2 Requests ahead")).toBeInTheDocument();
  });

  it("adds a Request with the toggled Players and closes once it is in the Queue", async () => {
    const { sent, server, onClose } = renderSheet({ kind: "add", songId: 40 });
    await screen.findByRole("dialog", { name: "Valerie" });
    fireEvent.click(await screen.findByRole("button", { name: /^Jonas/ }));
    expect(singer("Jonas")).toHaveAttribute("aria-pressed", "true");
    // Off and on again: a toggle.
    fireEvent.click(singer("Bo"));
    fireEvent.click(singer("Bo"));
    fireEvent.click(screen.getByRole("button", { name: "Add to the Queue" }));
    expect(sent).toEqual([
      { type: "addRequest", songId: 40, requestedPlayers: [2, 1] },
    ]);
    expect(onClose).not.toHaveBeenCalled();

    server({
      type: "partyChanged",
      party: {
        ...party,
        queue: [...party.queue, { ...request(3, 40, [2, 1]), adder: 1 }],
      },
      change: {
        actor: { kind: "member", memberId: 1 },
        event: {
          code: "requestAdded",
          params: { requestId: 3, songId: 40, title: "Valerie" },
        },
      },
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("adds a Request with nobody when every toggle is off", async () => {
    const { sent } = renderSheet({ kind: "add", songId: 40 });
    await screen.findByRole("dialog", { name: "Valerie" });
    fireEvent.click(await screen.findByRole("button", { name: /^Bo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to the Queue" }));
    expect(sent).toEqual([
      { type: "addRequest", songId: 40, requestedPlayers: [] },
    ]);
  });

  it("shows the server's refusal and stays open", async () => {
    const { server, onClose } = renderSheet({ kind: "add", songId: 40 });
    await screen.findByRole("dialog", { name: "Valerie" });
    fireEvent.click(screen.getByRole("button", { name: "Add to the Queue" }));
    server({ type: "rejected", reason: { code: "songPreparing" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /still being prepared/,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the singers of an existing Request, for Change singers", async () => {
    const { sent, server, onClose } = renderSheet({
      kind: "change",
      request: request(2, 41, [2]),
    });
    await screen.findByRole("dialog", { name: "Islands" });
    expect(
      await screen.findByRole("button", { name: /^Jonas/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(singer("Bo")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/Requests ahead/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add to the Queue" }),
    ).toBeNull();

    fireEvent.click(singer("Bo"));
    fireEvent.click(screen.getByRole("button", { name: "Save singers" }));
    expect(sent).toEqual([
      { type: "setRequestedPlayers", requestId: 2, requestedPlayers: [2, 1] },
    ]);
    server({
      type: "partyChanged",
      party: { ...party, queue: [request(1, 41), request(2, 41, [2, 1])] },
      change: {
        actor: { kind: "member", memberId: 1 },
        event: {
          code: "requestedPlayersChanged",
          params: { requestId: 2, songId: 41, title: "Islands" },
        },
      },
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes without sending when the singers did not change", async () => {
    const { sent, onClose } = renderSheet({
      kind: "change",
      request: request(2, 41, [2]),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save singers" }),
    );
    expect(sent).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the Request sheet's High score tables", () => {
  it("shows the top entries of one Difficulty, Medium first, with tabs for the others", async () => {
    renderSheet({ kind: "add", songId: 40 });
    const scores = await screen.findByRole("tabpanel", { name: "Medium" });
    const rows = await within(scores).findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^1.*Bo.*8,120$/),
      expect.stringMatching(/^2.*Jonas.*Older timing.*6,400$/),
    ]);
    // A solo Song has no Voice tabs.
    expect(screen.queryByRole("tab", { name: /Voice/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Hard" }));
    const hard = await screen.findByRole("tabpanel", { name: "Hard" });
    expect(within(hard).getByRole("listitem")).toHaveTextContent(
      /Jonas.*9,050/,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Easy" }));
    const easy = await screen.findByRole("tabpanel", { name: "Easy" });
    expect(easy).toHaveTextContent("No High scores yet");
  });

  it("has Voice tabs for a duet", async () => {
    renderSheet({ kind: "add", songId: 41 });
    const medium = await screen.findByRole("tabpanel", { name: "Medium" });
    expect(await within(medium).findByRole("listitem")).toHaveTextContent(
      /Bo.*5,000/,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Voice 2" }));
    const voice2 = await screen.findByRole("tabpanel", { name: "Medium" });
    expect(within(voice2).getByRole("listitem")).toHaveTextContent(
      /Jonas.*7,000/,
    );
  });
});
