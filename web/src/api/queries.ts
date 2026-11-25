// The app's queries, one `queryOptions` per HTTP+JSON resource. A screen
// reads one with `useQuery(serverInfoQuery)`; `changeNotices.ts` names its
// key under the change topic that invalidates it.

import { queryOptions } from "@tanstack/react-query";

import type { ProfileId } from "../generated/ProfileId";
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
