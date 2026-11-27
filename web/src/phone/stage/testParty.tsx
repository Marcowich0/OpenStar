// Shared test set-up for the Stage tab's component tests: a Party with a
// waiting Line-up, a live store fed by the test, and a fetch mock for the
// Profiles, the Song and the Local mics.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import type { ClientMessage } from "../../generated/ClientMessage";
import type { LineUp } from "../../generated/LineUp";
import type { PartyLocalMic } from "../../generated/PartyLocalMic";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { Seat } from "../../generated/Seat";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore, type LiveStore } from "../../live/liveStore";

const profile = (id: number, name: string): Profile => ({
  id,
  name,
  avatar: { kind: "builtIn", key: "cat" },
  favouriteColour: "cherry",
  lastDifficulty: "medium",
  createdAt: 0,
  lastSungAt: null,
});

export const PROFILES = [
  profile(7, "Bo"),
  profile(8, "Jonas"),
  profile(9, "Sara"),
];

const member = (
  memberId: number,
  profileId: number,
  colour: PartyMember["colour"],
): PartyMember => ({
  memberId,
  identity: { kind: "profile", profileId },
  colour,
  favouriteTaken: false,
  onPhone: true,
  singing: false,
});

/** Bo (member 1) uses this Phone, "bo-phone"; Jonas (2) "jonas-phone". */
export const MY_PHONE = "bo-phone";

/** The Party's switched-on Local mics. */
export const LOCAL_MICS: PartyLocalMic[] = [
  {
    localMicId: "red",
    name: "Red mic",
    present: true,
    source: {
      kind: "browser",
      stageBrowser: "s",
      deviceId: "d",
      label: "USB Audio",
      channel: 0,
      stereo: true,
    },
  },
];

/** Bo's seat: on this Phone, Medium. */
export const BO_SEAT: Seat = {
  memberId: 1,
  mic: { kind: "phone", phoneId: MY_PHONE },
  voice: "p1",
  difficulty: "medium",
};

/** Jonas's seat: on the Red mic, Hard. */
export const JONAS_SEAT: Seat = {
  memberId: 2,
  mic: { kind: "localMic", localMicId: "red" },
  voice: "p1",
  difficulty: "hard",
};

/** Bo and Jonas wait to sing Valerie (40). */
export const LINE_UP: LineUp = {
  requestId: 1,
  duet: false,
  canStart: true,
  warnings: [],
  seats: [BO_SEAT, JONAS_SEAT],
};

export const PARTY: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [member(1, 7, "cherry"), member(2, 8, "sky"), member(3, 9, "lime")],
  phones: [
    { phoneId: MY_PHONE, memberId: 1 },
    { phoneId: "jonas-phone", memberId: 2 },
  ],
  queue: [
    {
      requestId: 1,
      kind: "song",
      songId: 40,
      requestedPlayers: [1, 2],
      adder: 1,
    },
  ],
  head: 1,
  lineUp: LINE_UP,
  playing: null,
  results: null,
  localMics: LOCAL_MICS,
};

const song = (id: number, title: string, voices: number) => ({
  id,
  song: {
    headers: { title, artist: "Amy Winehouse" },
    voices: Array.from({ length: voices }, () => ({ lines: [] })),
  },
  lengthSeconds: 233.4,
  preparing: false,
  media: { cover: null, background: null, tileColour: "teal" },
});

const SONGS: Record<number, unknown> = {
  40: song(40, "Valerie", 1),
  41: song(41, "Islands", 2),
};

/** Answers the Profiles and the Song details. */
export function stubFetch() {
  stubFetchWith(() => undefined);
}

/**
 * `stubFetch`, answering more requests with `extra`: a response, or
 * `undefined` for the usual ones.
 */
export function stubFetchWith(extra: (url: URL) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(input, "http://openstar.test");
      const answered = extra(url);
      if (answered) return Promise.resolve(answered);
      const path = url.pathname;
      const songPath = /^\/api\/songs\/(\d+)$/.exec(path);
      if (songPath)
        return Promise.resolve(Response.json(SONGS[Number(songPath[1])]));
      if (path === "/api/profiles")
        return Promise.resolve(Response.json(PROFILES));
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
}

/** A live store on Bo's Phone, holding `party`, and what it sent. */
export function renderWithParty(
  party: PartySnapshot,
  ui: (store: LiveStore) => ReactNode,
) {
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
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      {ui(store)}
    </QueryClientProvider>,
  );
  /** The server's answer: the Party with `lineUp` changed. */
  const lineUpChanged = (
    lineUp: LineUp | null,
    rest: Partial<PartySnapshot> = {},
  ) => {
    server({
      type: "partyChanged",
      party: { ...party, ...rest, lineUp },
      change: {
        actor: { kind: "member", memberId: 1 },
        event: { code: "lineUpChanged" },
      },
    });
  };
  return { store, sent, server, lineUpChanged, view };
}
