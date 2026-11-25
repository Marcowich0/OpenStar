import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { profilesQuery, songsQuery } from "../../../api/queries";
import { createQueryClient } from "../../../api/queryClient";
import type { ChangeEvent } from "../../../generated/ChangeEvent";
import type { ClientMessage } from "../../../generated/ClientMessage";
import type { LineUp } from "../../../generated/LineUp";
import type { PartyMember } from "../../../generated/PartyMember";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { Request } from "../../../generated/Request";
import type { Seat } from "../../../generated/Seat";
import type { SongSummary } from "../../../generated/SongSummary";
import type { LiveClientOptions } from "../../../live/liveClient";
import { createLiveStore } from "../../../live/liveStore";
import { StageFrame } from "../../frame/StageFrame";

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (requestId: number, songId: number): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

const song = (id: number, title: string, duet = false): SongSummary => ({
  id,
  path: `${title}.txt`,
  artist: "Kiri",
  title,
  duet,
  identity: { kind: "artistTitle", artist: "Kiri", title, duet },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
});

const bo: Profile = {
  id: 7,
  name: "Bo",
  avatar: { kind: "builtIn", key: "cat" },
  favouriteColour: "sky",
  lastDifficulty: "medium",
  createdAt: 1,
  lastSungAt: null,
};

const guest = (memberId: number, name: string): PartyMember => ({
  memberId,
  identity: {
    kind: "guest",
    name,
    avatar: { kind: "builtIn", key: "cat" },
    difficulty: "medium",
  },
  colour: memberId === 2 ? "grape" : "tangerine",
  favouriteTaken: false,
  onPhone: memberId === 2,
  singing: false,
});

const members: PartyMember[] = [
  {
    memberId: 1,
    identity: { kind: "profile", profileId: 7 },
    colour: "sky",
    favouriteTaken: false,
    onPhone: true,
    singing: true,
  },
  guest(2, "Mia"),
  guest(3, "Jonas"),
];

const seat = (memberId: number, phoneId: string | null): Seat => ({
  memberId,
  mic: phoneId === null ? null : { kind: "phone", phoneId },
  voice: "p1",
  difficulty: "medium",
});

const lineUp = (over: Partial<LineUp> = {}): LineUp => ({
  requestId: 1,
  duet: false,
  seats: [seat(1, "ph-bo"), seat(2, "ph-mia")],
  canStart: true,
  warnings: [],
  ...over,
});

const party = (over: Partial<PartySnapshot> = {}): PartySnapshot => ({
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members,
  phones: [
    { phoneId: "ph-bo", memberId: 1 },
    { phoneId: "ph-mia", memberId: 2 },
  ],
  queue: [request(1, 10), request(2, 20), request(3, 30), request(4, 40)],
  head: 1,
  lineUp: lineUp(),
  playing: null,
  results: null,
  ...over,
});

function setup(snapshot: PartySnapshot = party()) {
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
  queries.setQueryData(profilesQuery.queryKey, [bo]);
  queries.setQueryData(songsQuery().queryKey, {
    songs: [
      song(10, "Islands", true),
      song(20, "Wave"),
      song(30, "Moon"),
      song(40, "Sun"),
    ],
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
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  render(
    <QueryClientProvider client={queries}>
      <StageFrame store={store} />
    </QueryClientProvider>,
  );
  live((h) => {
    h.onConnection("open");
    h.onMessage({
      type: "liveState",
      stageId: "main",
      party: snapshot,
      isStage: true,
    });
  });
  const changeParty = (next: PartySnapshot, change: ChangeEvent) => {
    live((h) => {
      h.onMessage({ type: "partyChanged", party: next, change });
    });
  };
  const edits = () =>
    sent.flatMap((m) => (m.type === "editLineUp" ? [m.edit] : []));
  return { sent, edits, changeParty };
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

function click(element: Element) {
  act(() => {
    fireEvent.click(element);
  });
}

const seats = () => screen.getAllByRole("group", { name: /^(Bo|Mia|Jonas)$/ });
const startButton = () => screen.getByRole("button", { name: /Start/ });

describe("the Line-up head", () => {
  it("shows the Song, its artist with '· duet', and the next two Songs", () => {
    setup(party({ lineUp: lineUp({ duet: true }) }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Islands" }),
    ).toBeVisible();
    expect(screen.getByText("Kiri · duet")).toBeVisible();
    expect(screen.getByText("Then Wave, Moon")).toBeVisible();
  });

  it("names fewer Songs when the Queue holds fewer, and none with the head alone", () => {
    setup(party({ queue: [request(1, 10), request(2, 20)] }));
    expect(screen.getByText("Then Wave")).toBeVisible();
  });

  it("leaves 'Then' out with the head alone, and never shows the Join code", () => {
    setup(party({ queue: [request(1, 10)] }));
    expect(screen.queryByText(/^Then/)).toBeNull();
    expect(screen.queryByText(/4821/)).toBeNull();
  });

  it("keeps the Setup pill in the pill row", () => {
    setup();
    expect(screen.getByRole("button", { name: "Setup" })).toBeVisible();
  });
});

describe("the seat cards", () => {
  it("shows one card per seat with Who, Mic, Voice (duets only) and Difficulty", () => {
    setup(party({ lineUp: lineUp({ duet: true }) }));
    expect(seats().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Bo",
      "Mia",
    ]);
    const card = within(seats()[0] as HTMLElement);
    expect(card.getByRole("button", { name: "Who: Bo" })).toBeVisible();
    expect(card.getByRole("button", { name: /Mic.*Bo's Phone/ })).toBeVisible();
    expect(card.getByRole("button", { name: /Voice.*1/ })).toBeVisible();
    expect(
      card.getByRole("button", { name: /Difficulty.*Medium/ }),
    ).toBeVisible();
  });

  it("leaves Voice out for a one-Voice Song", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Voice/ })).toBeNull();
  });

  it("offers 'Add a singer' while seats are free", () => {
    setup();
    expect(screen.getByRole("button", { name: /Add a singer/ })).toBeVisible();
  });

  it("has no 'Add a singer' once every seat is filled", () => {
    setup(
      party({
        members: [...members, guest(4, "Lu")],
        lineUp: lineUp({
          seats: [
            seat(1, "ph-bo"),
            seat(2, "ph-mia"),
            seat(3, null),
            seat(4, null),
          ],
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: /Add a singer/ })).toBeNull();
  });

  it("takes a Player off this Song with the ×", () => {
    const { edits } = setup();
    click(screen.getByRole("button", { name: "Take Mia off this Song" }));
    expect(edits()).toEqual([{ kind: "removeSeat", seat: 1 }]);
  });

  it("shows a level meter in every seat's Mic field", () => {
    setup(
      party({
        lineUp: lineUp({ seats: [seat(1, "ph-bo"), seat(3, null)] }),
      }),
    );
    for (const card of seats()) {
      expect(within(card).getByRole("meter")).toBeVisible();
    }
  });
});

describe("editing a seat", () => {
  it("cycles Voice 1 ↔ 2 and Difficulty Easy → Medium → Hard in place", () => {
    const { edits } = setup(party({ lineUp: lineUp({ duet: true }) }));
    const card = within(seats()[1] as HTMLElement);
    click(card.getByRole("button", { name: /Voice/ }));
    click(card.getByRole("button", { name: /Difficulty/ }));
    expect(edits()).toEqual([
      { kind: "setVoice", seat: 1, voice: "p2" },
      { kind: "setDifficulty", seat: 1, difficulty: "hard" },
    ]);
  });

  it("puts another Party member in a seat from the Who list", () => {
    const { edits } = setup();
    click(screen.getByRole("button", { name: "Who: Mia" }));
    const list = screen.getByRole("menu", { name: "Who sings" });
    expect(
      within(list)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Bo", "Mia", "Jonas"]);
    click(within(list).getByRole("menuitem", { name: /Jonas/ }));
    expect(edits()).toEqual([
      { kind: "setWho", seat: 1, who: { kind: "member", memberId: 3 } },
    ]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("adds a singer from the Who list of 'Add a singer'", () => {
    const { edits } = setup();
    click(screen.getByRole("button", { name: /Add a singer/ }));
    click(screen.getByRole("menuitem", { name: /Jonas/ }));
    expect(edits()).toEqual([
      { kind: "addSeat", who: { kind: "member", memberId: 3 } },
    ]);
  });

  it("lists the Mics, showing who has one in use, and sets a free one", () => {
    const { edits } = setup(
      party({
        phones: [
          { phoneId: "ph-bo", memberId: 1 },
          { phoneId: "ph-mia", memberId: 2 },
          { phoneId: "ph-jo", memberId: 3 },
        ],
      }),
    );
    click(screen.getByRole("button", { name: /Mic.*Bo's Phone/ }));
    const list = screen.getByRole("menu", { name: "Mic for Bo" });
    const items = within(list).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Bo's Phone",
      "Mia's PhoneMia has it",
      "Jonas's Phone",
    ]);
    // A Mic in use stays where it is.
    click(items[1] as HTMLElement);
    expect(edits()).toEqual([]);
    click(screen.getByRole("button", { name: /Mic.*Bo's Phone/ }));
    click(screen.getByRole("menuitem", { name: "Jonas's Phone" }));
    expect(edits()).toEqual([
      { kind: "setMic", seat: 0, mic: { kind: "phone", phoneId: "ph-jo" } },
    ]);
  });
});

describe("warnings and Start", () => {
  const invalid = party({
    lineUp: lineUp({
      duet: true,
      canStart: false,
      seats: [seat(1, "ph-bo"), seat(3, null)],
      warnings: [
        { code: "noMic", params: { memberId: 3 } },
        { code: "duetNeedsVoice", params: { voice: "p2" } },
      ],
    }),
  });

  it("hangs a seat's warning under its card and the Song's above Start", () => {
    setup(invalid);
    const jonas = within(seats()[1] as HTMLElement);
    expect(jonas.getByText("Jonas has no mic")).toBeVisible();
    expect(jonas.getByRole("button", { name: /Mic.*none/ })).toBeVisible();
    expect(
      within(seats()[0] as HTMLElement).queryByText(/has no mic/),
    ).toBeNull();
    expect(screen.getByText("A duet needs someone on Voice 2")).toBeVisible();
  });

  it("greys Start until the Line-up is valid; pressing it or Space starts nothing", () => {
    const { sent } = setup(invalid);
    expect(startButton()).toHaveAttribute("aria-disabled", "true");
    click(startButton());
    press(" ");
    expect(sent.filter((m) => m.type === "controlSong")).toEqual([]);
  });

  it("starts a ready Line-up with Start or Space", () => {
    const { sent } = setup();
    expect(startButton()).toHaveAttribute("aria-disabled", "false");
    press(" ");
    click(startButton());
    expect(sent.filter((m) => m.type === "controlSong")).toEqual([
      { type: "controlSong", requestId: 1, control: "start" },
      { type: "controlSong", requestId: 1, control: "start" },
    ]);
  });

  it("does not start on Space while a pick list is open", () => {
    const { sent } = setup();
    click(screen.getByRole("button", { name: "Who: Bo" }));
    press(" ");
    expect(sent.filter((m) => m.type === "controlSong")).toEqual([]);
  });
});

describe("changes while the Line-up waits", () => {
  const toasts = () => screen.getByRole("status", { name: "Party changes" });

  it("shows a Remote's edit at once, with a toast", () => {
    const { changeParty } = setup();
    changeParty(
      party({ lineUp: lineUp({ seats: [seat(1, "ph-bo"), seat(3, null)] }) }),
      {
        actor: { kind: "member", memberId: 2 },
        event: { code: "lineUpChanged" },
      },
    );
    expect(seats().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Bo",
      "Jonas",
    ]);
    expect(within(toasts()).getByText(/changed the Line-up/)).toBeVisible();
  });

  it("does not toast the Stage's own edits", () => {
    const { changeParty } = setup();
    changeParty(party({ lineUp: lineUp({ seats: [seat(1, "ph-bo")] }) }), {
      actor: { kind: "stage" },
      event: { code: "lineUpChanged" },
    });
    expect(seats()).toHaveLength(1);
    expect(within(toasts()).queryByText(/Line-up/)).toBeNull();
  });
});
