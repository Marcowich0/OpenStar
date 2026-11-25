import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Request } from "../../generated/Request";
import type { SongList } from "../../generated/SongList";
import { userMessageText } from "../../i18n/serverText";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { SHEET_ENTER_MS } from "../../ui/Sheet";
import {
  guestMember,
  partyOf,
  profile,
  profileMember,
  renderJoinedPhone,
} from "../people/testPhone";

const PROFILES = [
  profile(7, "Bo", { favouriteColour: "cherry" }),
  profile(8, "Jonas", { favouriteColour: "teal" }),
];

/** A Song detail with only the fields the tab and the Request sheet read. */
const detail = (id: number, title: string, artist: string) => ({
  id,
  song: { headers: { title, artist }, voices: [{ lines: [] }] },
  lengthSeconds: 200,
  preparing: false,
  media: { cover: null, background: null, tileColour: "teal" },
});

const SONGS: Record<string, unknown> = {
  "10": detail(10, "Shallow", "Lady Gaga"),
  "20": detail(20, "Africa", "Toto"),
  "30": detail(30, "Mr. Brightside", "The Killers"),
  "40": detail(40, "Take On Me", "a-ha"),
};

const NO_SONGS: SongList = {
  songs: [],
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
};

function serverFetch(input: string | URL) {
  const path = new URL(input, "http://openstar.test").pathname;
  const song = /^\/api\/songs\/(\d+)$/.exec(path);
  const body =
    path === "/api/songs"
      ? NO_SONGS
      : song
        ? SONGS[song[1] ?? ""]
        : path.endsWith("/high-scores")
          ? { tables: [] }
          : PROFILES;
  return Promise.resolve(Response.json(body));
}

const bo = profileMember(1, 7, "cherry");
const jonas = profileMember(2, 8, "teal");
const kim = guestMember(3, "Kim", "lime");

const request = (
  requestId: number,
  songId: number,
  requestedPlayers: number[],
  adder: number | null,
): Request => ({ requestId, kind: "song", songId, requestedPlayers, adder });

const QUEUE = [
  request(1, 10, [1, 2], 2),
  request(2, 20, [3], 1),
  request(3, 30, [], null),
  request(4, 40, [1], 3),
];

const PARTY: PartySnapshot = {
  ...partyOf([bo, jonas, kim]),
  queue: QUEUE,
  head: 1,
};

const PLAYING: PartySnapshot = {
  ...PARTY,
  lineUp: null,
  playing: { requestId: 1, songId: 10, paused: false },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(serverFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openQueue(snapshot = PARTY) {
  const phone = renderJoinedPhone(snapshot);
  act(() => {
    fireEvent.click(screen.getByRole("tab", { name: /^Queue/ }));
  });
  await screen.findByRole("button", { name: /Take On Me/ });
  return phone;
}

const card = (title: RegExp) => screen.getByRole("button", { name: title });

/** Opens a card's sheet and waits for it to have slid in. */
async function openSheet(title: RegExp) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  act(() => {
    fireEvent.click(card(title));
  });
  const sheet = await screen.findByRole("dialog");
  act(() => {
    vi.advanceTimersByTime(SHEET_ENTER_MS);
  });
  return sheet;
}

const actionNames = (sheet: HTMLElement) =>
  within(sheet)
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("the Queue tab", () => {
  it("shows numbered Request cards with title, singers and who added them", async () => {
    await openQueue();
    const cards = within(screen.getByRole("list", { name: "Queue" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(cards).toEqual([
      expect.stringMatching(/^1.*Shallow.*Bo, Jonas.*added by Jonas/),
      expect.stringMatching(/^2.*Africa.*Kim.*added by Bo/),
      expect.stringMatching(/^3.*Mr\. Brightside.*Anyone.*from the Stage/),
      expect.stringMatching(/^4.*Take On Me.*Bo.*added by Kim/),
    ]);
  });

  it("highlights the head as up next, and as playing now while its Song plays", async () => {
    await openQueue();
    expect(within(card(/Shallow/)).getByText("Up next")).toBeInTheDocument();
    expect(within(card(/Africa/)).queryByText("Up next")).toBeNull();
  });

  it("says playing now on the head while its Song plays", async () => {
    await openQueue(PLAYING);
    expect(
      within(card(/Shallow/)).getByText("Playing now"),
    ).toBeInTheDocument();
  });

  it("says when nothing is queued", async () => {
    renderJoinedPhone(partyOf([bo, jonas]));
    act(() => {
      fireEvent.click(screen.getByRole("tab", { name: /^Queue/ }));
    });
    expect(await screen.findByText("Nothing queued")).toBeInTheDocument();
  });

  it("has no drag to reorder", async () => {
    await openQueue();
    expect(document.querySelector("[draggable=true]")).toBeNull();
  });
});

describe("a Request card's sheet", () => {
  it("offers a Request below the second place every move", async () => {
    await openQueue();
    const sheet = await openSheet(/Mr\. Brightside/);
    expect(
      within(sheet).getByText("Number 3 in the Queue"),
    ).toBeInTheDocument();
    expect(actionNames(sheet)).toEqual([
      "Play next",
      "Move up",
      "Move down",
      "Change singers",
      "Remove from the Queue",
    ]);
  });

  it("offers the head no move, and the second place only Move down", async () => {
    await openQueue();
    const head = await openSheet(/Shallow/);
    expect(within(head).getByText("Up next on the Stage")).toBeInTheDocument();
    expect(actionNames(head)).toEqual([
      "Change singers",
      "Remove from the Queue",
    ]);
  });

  it("offers the second place only Move down of the moves", async () => {
    await openQueue();
    const sheet = await openSheet(/Africa/);
    expect(actionNames(sheet)).toEqual([
      "Move down",
      "Change singers",
      "Remove from the Queue",
    ]);
  });

  it("tells that the playing Request is removed by Skip or End", async () => {
    await openQueue(PLAYING);
    const sheet = await openSheet(/Shallow/);
    expect(actionNames(sheet)).toEqual(["Change singers"]);
    expect(
      within(sheet).getByText("It is playing now. Use Skip or End"),
    ).toBeInTheDocument();
  });

  it("sends Move up and closes once the Queue shows it", async () => {
    const { sent, change } = await openQueue();
    const sheet = await openSheet(/Take On Me/);
    act(() => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Move up" }));
    });
    expect(sent).toContainEqual({
      type: "moveRequest",
      requestId: 4,
      to: "up",
    });
    const moved = [QUEUE[0], QUEUE[1], QUEUE[3], QUEUE[2]] as Request[];
    change(
      { kind: "member", memberId: 1 },
      {
        code: "requestMovedUp",
        params: { requestId: 4, songId: 40, title: "Take On Me" },
      },
      { ...PARTY, queue: moved },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Party changes" }),
    ).toHaveTextContent("You moved Take On Me up");
    const cards = within(screen.getByRole("list", { name: "Queue" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(cards[2]).toMatch(/^3.*Take On Me/);
  });

  it("sends Play next", async () => {
    const { sent } = await openQueue();
    const sheet = await openSheet(/Take On Me/);
    act(() => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Play next" }));
    });
    expect(sent).toContainEqual({
      type: "moveRequest",
      requestId: 4,
      to: "next",
    });
  });

  it("shows the server's refusal in the sheet", async () => {
    const { server } = await openQueue();
    const sheet = await openSheet(/Africa/);
    act(() => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Move down" }));
    });
    server({ type: "rejected", reason: { code: "requestCannotMove" } });
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      userMessageText({ code: "requestCannotMove" }),
    );
  });

  it("removes a Request with a press and hold", async () => {
    const { sent } = await openQueue();
    const sheet = await openSheet(/Africa/);
    const remove = within(sheet).getByRole("button", {
      name: "Remove from the Queue",
    });
    act(() => {
      fireEvent.click(remove);
    });
    expect(sent.some((m) => m.type === "removeRequest")).toBe(false);
    act(() => {
      fireEvent.pointerDown(remove);
      vi.advanceTimersByTime(HOLD_DURATION_MS);
      fireEvent.pointerUp(remove);
    });
    expect(sent).toContainEqual({ type: "removeRequest", requestId: 2 });
  });

  it("names who did it in the toast when another Phone moves a Request", async () => {
    const { change } = await openQueue();
    change(
      { kind: "member", memberId: 2 },
      {
        code: "requestPlayNext",
        params: { requestId: 4, songId: 40, title: "Take On Me" },
      },
      {
        ...PARTY,
        queue: [QUEUE[0], QUEUE[3], QUEUE[1], QUEUE[2]] as Request[],
      },
    );
    expect(
      screen.getByRole("status", { name: "Party changes" }),
    ).toHaveTextContent("Jonas made Take On Me play next");
    const cards = within(screen.getByRole("list", { name: "Queue" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(cards[1]).toMatch(/^2.*Take On Me/);
  });

  it("opens the Request sheet in its Save singers form for Change singers", async () => {
    const { sent } = await openQueue();
    const sheet = await openSheet(/Africa/);
    act(() => {
      fireEvent.click(
        within(sheet).getByRole("button", { name: "Change singers" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHEET_ENTER_MS);
    });
    const save = await screen.findByRole("button", { name: "Save singers" });
    const singers = screen.getByRole("dialog", { name: "Africa" });
    expect(
      within(singers).getByRole("button", { name: /Kim/, pressed: true }),
    ).toBeInTheDocument();
    act(() => {
      fireEvent.click(
        within(singers).getByRole("button", { name: /Bo/, pressed: false }),
      );
    });
    act(() => {
      fireEvent.click(save);
    });
    expect(sent).toContainEqual({
      type: "setRequestedPlayers",
      requestId: 2,
      requestedPlayers: [3, 1],
    });
  });
});
