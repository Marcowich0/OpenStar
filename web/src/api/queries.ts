// The app's queries, one `queryOptions` per HTTP+JSON resource. A screen
// reads one with `useQuery(serverInfoQuery)`; `changeNotices.ts` names its
// key under the change topic that invalidates it.

import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";

/** `GET /api/server-info`: the server's version, schema and Library state. */
export const serverInfoQuery = queryOptions({
  queryKey: ["serverInfo"],
  queryFn: ({ signal }) => api("GET /api/server-info", { signal }),
});
