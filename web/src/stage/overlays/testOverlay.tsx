// Test harness for the Stage's overlays: the real frame and overlays over a
// stand-in scene, a fake live socket and a query cache with the Songs set up
// front. Tests only.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react";

import {
  profilesQuery,
  serverInfoQuery,
  songQuery,
  songsQuery,
} from "../../api/queries";
import { createQueryClient } from "../../api/queryClient";
import type { Actor } from "../../generated/Actor";
import type { ClientMessage } from "../../generated/ClientMessage";
import type { PartyEvent } from "../../generated/PartyEvent";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { Request } from "../../generated/Request";
import type { SongDetail } from "../../generated/SongDetail";
import type { SongSummary } from "../../generated/SongSummary";
import type { UserMessage } from "../../generated/UserMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { SCENES } from "../frame/sceneComponents";
import { StageFrame } from "../frame/StageFrame";

export const summary = (id: number, title: string): SongSummary => ({
  id,
  path: `${title}.txt`,
  artist: `${title} Band`,
  title,
  duet: false,
  identity: { kind: "artistTitle", artist: "x", title, duet: false },
  lengthSeconds: 200,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
});

const detail = (song: SongSummary): SongDetail =>
  ({
    id: song.id,
    lengthSeconds: 200,
    preparing: false,
    loudnessLufs: null,
    song: {
      headers: {
        title: song.title,
        artist: song.artist,
        genre: null,
        previewStartSeconds: 30,
      },
    },
    media: { cover: null, tileColour: "teal", audio: null },
  }) as unknown as SongDetail;

export const request = (
  requestId: number,
  songId: number,
  more: Partial<Request> = {},
): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
  ...more,
});

function Empty() {
  return <div />;
}

/** Every scene is empty, so only the overlay draws; overlays may open. */
const STAND_INS = Object.fromEntries(
  Object.keys(SCENES).map((id) => [id, { component: Empty }]),
) as unknown as typeof SCENES;

export function renderOverlays(
  snapshot: PartySnapshot,
  {
    songs = [],
    profiles = [],
  }: { songs?: SongSummary[]; profiles?: Profile[] } = {},
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
  const queries = createQueryClient();
  queries.setQueryData(songsQuery().queryKey, {
    songs,
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
  for (const s of songs)
    queries.setQueryData(songQuery(s.id).queryKey, detail(s));
  queries.setQueryData(profilesQuery.queryKey, profiles);
  queries.setQueryData(serverInfoQuery.queryKey, {
    version: "test",
    schemaVersion: 1,
    libraryReadOnly: null,
    publicUrl: "https://party.example",
  });
  const live = (fn: (h: NonNullable<typeof handlers>) => void) => {
    act(() => {
      if (handlers) fn(handlers);
    });
  };
  const view = render(
    <QueryClientProvider client={queries}>
      <StageFrame
        store={store}
        scenes={STAND_INS}
        chooseScene={() => "songBrowser"}
      />
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
  const changeParty = (
    next: PartySnapshot,
    actor: Actor = { kind: "stage" },
    event: PartyEvent = {
      code: "requestAdded",
      params: { requestId: 1, songId: 1, title: "Africa" },
    },
  ) => {
    live((h) => {
      h.onMessage({
        type: "partyChanged",
        party: next,
        change: { actor, event },
      });
    });
  };
  const reject = (reason: UserMessage) => {
    live((h) => {
      h.onMessage({ type: "rejected", reason });
    });
  };
  return { sent, store, queries, changeParty, reject, ...view };
}

export function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

export function click(element: Element) {
  act(() => {
    fireEvent.click(element);
  });
}
