// The Stage's one playing Song per live store (`stageSong.ts`), wired to the
// real Song detail, Profiles, Pitch router, playback adapter and Stage audio.
// `StageScreen` makes it as soon as the Stage opens, so it hears every
// `controlSong` from the first; the sing scene reads it.

import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { useContext, useSyncExternalStore } from "react";

import { api } from "../../../api/api";
import { createQueryClient } from "../../../api/queryClient";
import { profilesQuery, songQuery } from "../../../api/queries";
import { stagePitch } from "../../../live/browserLive";
import type { LiveStore } from "../../../live/liveStore";
import { createMediaPlayback } from "../../../playback/mediaPlayback";
import { stageAudio } from "../../playback/stageAudio";
import { stagePreview } from "../../playback/stagePreview";
import {
  createStageSong,
  type StageSong,
  type StageSongView,
} from "./stageSong";

/** How long the AudioContext may take to resume before the Stage offers Play. */
const RESUME_TIMEOUT_MS = 2000;

const songs = new WeakMap<LiveStore, StageSong>();

/** The chain, made on first use (the Stage's AudioContext with it). */
const chain = {
  connectMedia: (element: HTMLMediaElement) =>
    stageAudio().chain().connectMedia(element),
  setSongLoudness: (lufs: number | null) => {
    stageAudio().chain().setSongLoudness(lufs);
  },
};

/**
 * Resumes the Stage's AudioContext. Without a user gesture Chromium leaves
 * the promise pending, so give up after a while and offer Play.
 */
function resumeAudio(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the AudioContext did not resume"));
    }, RESUME_TIMEOUT_MS);
    stageAudio()
      .resume()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

export function stageSongFor(
  store: LiveStore,
  queryClient: QueryClient,
): StageSong {
  let song = songs.get(store);
  if (!song) {
    song = createStageSong({
      store,
      loadSong: async (id) => {
        // The lane headers name the Players: have the Profiles at hand.
        await queryClient.query(profilesQuery).catch(() => undefined);
        return queryClient.query(songQuery(id));
      },
      profiles: () => queryClient.getQueryData(profilesQuery.queryKey),
      pitch: stagePitch(),
      createPlayback: ({ element, plan, clock, onEnded }) => {
        // The song browser's preview never plays under a Song.
        stagePreview().stop();
        return createMediaPlayback({
          element,
          plan,
          clock,
          chain,
          outputLatencyMs: () => stageAudio().outputLatencyMs(),
          onEnded,
        });
      },
      resumeAudio,
      postRound: (outcome) => api("POST /api/rounds", { body: outcome }),
    });
    songs.set(store, song);
  }
  return song;
}

let ownQueryClient: QueryClient | null = null;

/**
 * The Stage's playing Song for `store`, made on first use, with the app's
 * query client (or one of its own outside a `QueryClientProvider`, as in the
 * frame's tests).
 */
export function useStageSong(store: LiveStore): StageSong {
  const queryClient = useContext(QueryClientContext);
  return stageSongFor(
    store,
    queryClient ?? (ownQueryClient ??= createQueryClient()),
  );
}

/** What the sing scene shows; re-renders on each change. */
export function useStageSongView(song: StageSong): StageSongView {
  return useSyncExternalStore(
    (listener) => song.subscribe(listener),
    () => song.view(),
  );
}
