// The app's queries, one `queryOptions` per HTTP+JSON resource. A screen
// reads one with `useQuery(serverInfoQuery)`; `changeNotices.ts` names its
// key under the change topic that invalidates it.

import { queryOptions } from "@tanstack/react-query";

import type { ProfileId } from "../generated/ProfileId";
import type { SongId } from "../generated/SongId";
import { api } from "./api";

/** `GET /api/server-info`: the server's version, schema and Library state. */
export const serverInfoQuery = queryOptions({
  queryKey: ["serverInfo"],
  queryFn: ({ signal }) => api("GET /api/server-info", { signal }),
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

/** `GET /api/songs`: every playable Song in the Library index. */
export const songsQuery = queryOptions({
  queryKey: ["songs"],
  queryFn: ({ signal }) => api("GET /api/songs", { signal }),
});

/** `GET /api/songs/{id}`: one playable Song. Its key starts with the list's. */
export function songQuery(id: SongId) {
  return queryOptions({
    queryKey: ["songs", id],
    queryFn: ({ signal }) =>
      api("GET /api/songs/{id}", { params: { id: String(id) }, signal }),
  });
}

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
