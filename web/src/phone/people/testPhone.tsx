// The Phone page under test, with a live store whose server the test plays.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";

import { createQueryClient } from "../../api/queryClient";
import type { ClientMessage } from "../../generated/ClientMessage";
import type { PartyEvent } from "../../generated/PartyEvent";
import type { PartyMember } from "../../generated/PartyMember";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { SongList } from "../../generated/SongList";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import type { PhoneStorage } from "../../live/phoneId";
import { PhonePageView } from "../PhoneScreen";

export const PHONE_ID = "phone-a";

export function profile(
  id: number,
  name: string,
  more: Partial<Profile> = {},
): Profile {
  return {
    id,
    name,
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 0,
    lastSungAt: null,
    ...more,
  };
}

export function profileMember(
  memberId: number,
  profileId: number,
  colour: PartyMember["colour"],
  more: Partial<PartyMember> = {},
): PartyMember {
  return {
    memberId,
    identity: { kind: "profile", profileId },
    colour,
    favouriteTaken: false,
    onPhone: true,
    singing: false,
    ...more,
  };
}

export function guestMember(
  memberId: number,
  name: string,
  colour: PartyMember["colour"],
  more: Partial<PartyMember> = {},
): PartyMember {
  return {
    memberId,
    identity: {
      kind: "guest",
      name,
      avatar: { kind: "builtIn", key: "flame" },
      difficulty: "medium",
    },
    colour,
    favouriteTaken: false,
    onPhone: true,
    singing: false,
    ...more,
  };
}

export function partyOf(members: PartyMember[]): PartySnapshot {
  return {
    partyId: "p1",
    stageId: "main",
    joinCode: "4821",
    startedAtMs: 1,
    members,
    phones: members.map((m) => ({
      phoneId: m.memberId === 1 ? PHONE_ID : `phone-${String(m.memberId)}`,
      memberId: m.memberId,
    })),
    queue: [],
    head: null,
    lineUp: null,
    playing: null,
    results: null,
  };
}

export function memoryStorage(
  initial: Record<string, string> = {},
): PhoneStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/**
 * Renders the Phone page already in `snapshot` as member `memberId` (1 by
 * default): the socket opens, the Party arrives and the Phone id is answered.
 */
export function renderJoinedPhone(
  snapshot: PartySnapshot,
  {
    memberId = 1,
    storage = memoryStorage({ "openstar.phoneId": PHONE_ID }),
  }: { memberId?: number | null; storage?: PhoneStorage } = {},
) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore(
    (given) => {
      handlers = given;
      return {
        send: (message) => {
          sent.push(message);
          return true;
        },
        close: () => {},
      };
    },
    () => ({ type: "hello", phoneId: PHONE_ID }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PhonePageView joinCode={undefined} store={store} storage={storage} />
    </QueryClientProvider>,
  );
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
    { type: "phoneStatus", memberId },
  );
  /** Another Remote, the Stage or this Phone changed the Party. */
  const change = (
    actor: { kind: "stage" } | { kind: "member"; memberId: number },
    event: PartyEvent,
    party: PartySnapshot,
  ) => {
    server({ type: "partyChanged", party, change: { actor, event } });
  };
  return { sent, server, change, storage };
}

/** An empty Library for the Songs tab. */
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

/** Answers the Songs tab with an empty Library, anything else with the Profiles. */
export function profilesFetch(profiles: Profile[]) {
  return (input: string | URL) =>
    Promise.resolve(
      Response.json(
        new URL(input, "http://openstar.test").pathname === "/api/songs"
          ? NO_SONGS
          : profiles,
      ),
    );
}
