import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ChangeTopic } from "../generated/ChangeTopic";
import type { LiveConnection } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import {
  libraryProblemsQuery,
  profilesQuery,
  scanStatusQuery,
  serverInfoQuery,
  songsKey,
} from "./queries";

/**
 * The queries each change topic invalidates. A key matches every query it
 * prefixes (`["profiles"]` also covers `["profiles", id]`). A topic added on
 * the Rust side fails `tsc` here until it names its queries.
 */
export const QUERIES_BY_TOPIC: Record<ChangeTopic, readonly QueryKey[]> = {
  serverInfo: [serverInfoQuery.queryKey],
  profiles: [profilesQuery.queryKey],
  library: [songsKey, libraryProblemsQuery.queryKey, scanStatusQuery.queryKey],
  // No Mic settings query exists yet. The ticket that adds one (it reads
  // `GET /api/mic-settings`) starts its key with this prefix.
  micSettings: [["micSettings"]],
};

const TOPICS = Object.keys(QUERIES_BY_TOPIC) as ChangeTopic[];

/**
 * Keeps the query cache current from the WebSocket: each change notice
 * invalidates the queries its topics name, so the screens showing them
 * refetch and the others refetch when they next open. After a reconnect
 * every query is invalidated, because notices sent while the socket was
 * down are lost. Returns the function that stops it.
 */
export function invalidateOnChange(
  store: Pick<LiveStore, "onChanged" | "subscribe" | "getSnapshot">,
  queryClient: QueryClient,
): () => void {
  const stops = TOPICS.map((topic) =>
    store.onChanged(topic, () => {
      for (const queryKey of QUERIES_BY_TOPIC[topic]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }),
  );

  let connection: LiveConnection = store.getSnapshot().connection;
  let missedNotices = false;
  stops.push(
    store.subscribe(() => {
      const previous = connection;
      connection = store.getSnapshot().connection;
      if (connection === previous) return;
      if (connection === "reconnecting") missedNotices = true;
      if (connection === "open" && missedNotices) {
        missedNotices = false;
        void queryClient.invalidateQueries();
      }
    }),
  );

  return () => {
    for (const stop of stops) stop();
  };
}
