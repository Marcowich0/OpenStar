import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../api/queryClient";
import type { ClientMessage } from "../generated/ClientMessage";
import type { PartyEvent } from "../generated/PartyEvent";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import type { Request } from "../generated/Request";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { Remote } from "./Remote";

const PROFILES: Profile[] = [
  {
    id: 7,
    name: "Bo",
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
  },
  {
    id: 8,
    name: "Jonas",
    avatar: { kind: "builtIn", key: "star" },
    favouriteColour: "sky",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
  },
];

/** The Song details the strip reads: only the fields it uses. */
const SONGS: Record<number, unknown> = {
  40: {
    id: 40,
    song: { headers: { title: "Valerie", artist: "Amy Winehouse" } },
    media: { cover: null, background: null, tileColour: "teal" },
  },
};

const request = (requestId: number, songId: number): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

/** Bo (member 1) uses this Phone; Jonas (member 2) another. */
const idle: PartySnapshot = {
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
    },
    {
      memberId: 2,
      identity: { kind: "profile", profileId: 8 },
      colour: "sky",
      favouriteTaken: false,
      onPhone: true,
    },
  ],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
};

const waiting: PartySnapshot = {
  ...idle,
  queue: [request(1, 40), request(2, 41), request(3, 42)],
  head: 1,
  lineUp: {
    requestId: 1,
    duet: false,
    seats: [],
    canStart: false,
    warnings: [],
  },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const path = new URL(input, "http://openstar.test").pathname;
      const song = /^\/api\/songs\/(\d+)$/.exec(path);
      if (song) return Promise.resolve(Response.json(SONGS[Number(song[1])]));
      return Promise.resolve(Response.json(PROFILES));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The Remote of a Phone already in the Party as Bo. */
function renderRemote(snapshot: PartySnapshot) {
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
    { type: "liveState", stageId: "main", party: snapshot, isStage: false },
    { type: "phoneStatus", memberId: 1 },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Remote store={store} />
    </QueryClientProvider>,
  );
  /** Another Remote, the Stage or this Phone changed the Party. */
  const change = (
    actor: { kind: "stage" } | { kind: "member"; memberId: number },
    event: PartyEvent,
    party: PartySnapshot = snapshot,
  ) => {
    server({ type: "partyChanged", party, change: { actor, event } });
  };
  return { sent, server, change };
}

const selected = () =>
  screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-key");

describe("the Remote frame", () => {
  it("opens on Songs while no Line-up waits", () => {
    renderRemote(idle);
    expect(screen.getByRole("tab", { name: "Songs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens on the Stage tab while a Line-up waits", () => {
    renderRemote(waiting);
    expect(screen.getByRole("tab", { name: /Stage/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("counts the Requests in the Queue tab's badge", () => {
    const { change } = renderRemote(idle);
    expect(screen.getByRole("tab", { name: "Queue" })).toBeInTheDocument();

    change(
      { kind: "stage" },
      {
        code: "requestAdded",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
      waiting,
    );
    const queue = screen.getByRole("tab", { name: "Queue, 3 Requests" });
    expect(within(queue).getByText("3")).toBeInTheDocument();
  });

  it("shows the waiting Line-up in the strip, off the Stage tab, and opens the Stage tab on a tap", async () => {
    renderRemote(waiting);
    // It opened on the Stage tab, where the strip is never shown.
    expect(screen.queryByText("Waiting for Start")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Songs" }));
    const strip = await screen.findByRole("button", {
      name: /Line-up for Valerie/,
    });
    expect(within(strip).getByText("Waiting for Start")).toBeInTheDocument();

    fireEvent.click(strip);
    expect(screen.getByRole("tab", { name: /Stage/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByText("Waiting for Start")).toBeNull();
  });

  it("hides the strip while no Line-up waits", () => {
    renderRemote(idle);
    expect(screen.queryByText("Waiting for Start")).toBeNull();
    expect(screen.queryByRole("button", { name: /Line-up/ })).toBeNull();
  });

  it("offers no guarded action: only the tabs, and the strip to the Stage tab", async () => {
    const { sent } = renderRemote(waiting);
    fireEvent.click(screen.getByRole("tab", { name: "Songs" }));
    await screen.findByRole("button", { name: /Line-up for Valerie/ });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringContaining("Line-up for Valerie"),
    ]);
    expect(sent).toEqual([]);
    expect(selected()).toBe("songs");
  });
});

describe("the Remote's toasts", () => {
  it("show another Remote's change with its avatar, at the top", async () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "member", memberId: 2 },
      {
        code: "requestMovedUp",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    const toast = await within(toasts).findByText(
      (_, element) =>
        element?.tagName === "LI" &&
        element.textContent === "Jonas moved Valerie up",
    );
    expect(within(toast).getByText("Valerie").tagName).toBe("B");
    // The name is in the text; the avatar beside it is not read twice.
    expect(
      within(toast).getByRole("img", { name: "Jonas", hidden: true }),
    ).toBeInTheDocument();
  });

  it("show the Stage's changes too", () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "stage" },
      {
        code: "requestRemoved",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("Valerie was removed from the Queue");
  });

  it("say “you” for this Phone's own changes", () => {
    const { change } = renderRemote(idle);
    change(
      { kind: "member", memberId: 1 },
      {
        code: "requestMovedUp",
        params: { requestId: 1, songId: 41, title: "Africa" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("You moved Africa up");
  });

  it("go away after a few seconds", () => {
    vi.useFakeTimers();
    const { change } = renderRemote(idle);
    change(
      { kind: "stage" },
      {
        code: "requestRemoved",
        params: { requestId: 1, songId: 40, title: "Valerie" },
      },
    );
    const toasts = screen.getByRole("status", { name: "Party changes" });
    expect(toasts).toHaveTextContent("Valerie");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(toasts).toBeEmptyDOMElement();
  });
});
