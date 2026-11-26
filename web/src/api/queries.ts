// The app's queries, one `queryOptions` per HTTP+JSON resource. A screen
// reads one with `useQuery(serverInfoQuery)`; `changeNotices.ts` names its
// key under the change topic that invalidates it.

import { queryOptions } from "@tanstack/react-query";

import type { ProfileId } from "../generated/ProfileId";
import type { SongId } from "../generated/SongId";
import type { SongQuery } from "../generated/SongQuery";
import { api } from "./api";

/** `GET /api/server-info`: the server's version, schema and Library state. */
export const serverInfoQuery = queryOptions({
  queryKey: ["serverInfo"],
  queryFn: ({ signal }) => api("GET /api/server-info", { signal }),
});

/**
 * `GET /api/unlock`: whether this browser holds an Unlock. The guarded-action
 * flow (`guarded/`) keeps it current from every guarded answer, the
 * heartbeat and Lock; it is only a display hint, the server decides.
 */
export const unlockQuery = queryOptions({
  queryKey: ["unlock"],
  queryFn: ({ signal }) => api("GET /api/unlock", { signal }),
});

/** `GET /api/profiles`: every Profile, in "Who's singing?" order. */
export const profilesQuery = queryOptions({
  queryKey: ["profiles"],
  queryFn: ({ signal }) => api("GET /api/profiles", { signal }),
});

/** `GET /api/profiles/{id}`: one Profile. Its key starts with the list's. */
export function profileQuery(id: ProfileId) {
  return queryOptions({
    queryKey: ["profiles", id],
    queryFn: ({ signal }) =>
      api("GET /api/profiles/{id}", { params: { id: String(id) }, signal }),
  });
}

/** The prefix of every Song query's key: the lists' and each Song's. */
export const songsKey = ["songs"] as const;

/**
 * `GET /api/songs`: the playable Songs that match `query` (search and
 * filters; empty: every one), and the values each filter can take. Each
 * query has its own cache entry under `songsKey`.
 */
export function songsQuery(query: SongQuery = {}) {
  return queryOptions({
    queryKey: [...songsKey, "list", query],
    queryFn: ({ signal }) => api("GET /api/songs", { query, signal }),
  });
}

/** `GET /api/songs/{id}`: one playable Song. Its key starts with `songsKey`. */
export function songQuery(id: SongId) {
  return queryOptions({
    queryKey: [...songsKey, id],
    queryFn: ({ signal }) =>
      api("GET /api/songs/{id}", { params: { id: String(id) }, signal }),
  });
}

/**
 * `GET /api/songs/{id}/high-scores`: the Song's High score tables, one per
 * Voice and Difficulty. Its key starts with `songsKey`, so the `library`
 * notice a stored round sends refreshes it.
 */
export function songHighScoresQuery(id: SongId) {
  return queryOptions({
    queryKey: [...songsKey, id, "highScores"],
    queryFn: ({ signal }) =>
      api("GET /api/songs/{id}/high-scores", {
        params: { id: String(id) },
        signal,
      }),
  });
}

/**
 * `GET /api/library/originals`: the Songs with an Original to restore. Its
 * key starts with `songsKey`, so the `library` notice refreshes it.
 */
export const originalsQuery = queryOptions({
  queryKey: [...songsKey, "originals"],
  queryFn: ({ signal }) => api("GET /api/library/originals", { signal }),
});

/** `GET /api/library/problems`: every Library problem. */
export const libraryProblemsQuery = queryOptions({
  queryKey: ["library", "problems"],
  queryFn: ({ signal }) => api("GET /api/library/problems", { signal }),
});

/** `GET /api/library/scan`: the state of the scan. */
export const scanStatusQuery = queryOptions({
  queryKey: ["library", "scan"],
  queryFn: ({ signal }) => api("GET /api/library/scan", { signal }),
});

/**
 * `GET /api/local-mics`: every kept Local mic (name, switched on). Its key
 * starts with `micSettings`, the change topic the Stage's writes send.
 */
export const localMicsQuery = queryOptions({
  queryKey: ["micSettings", "localMics"],
  queryFn: ({ signal }) => api("GET /api/local-mics", { signal }),
});

/**
 * `GET /api/mic-bridges`: approved Mic bridges (open or closed, with their
 * channels) in order of approval, and bridges waiting for approval.
 */
export const micBridgesQuery = queryOptions({
  queryKey: ["micBridges"],
  queryFn: ({ signal }) => api("GET /api/mic-bridges", { signal }),
});

/**
 * `GET /api/usdb/mirror`: where the USDB mirror stands (empty, filling,
 * fresh, ...). The Downloads section asks for a fresh mirror with
 * `POST /api/usdb/mirror/refresh` when it opens.
 */
export const usdbMirrorQuery = queryOptions({
  queryKey: ["usdb", "mirror"],
  queryFn: ({ signal }) => api("GET /api/usdb/mirror", { signal }),
});
