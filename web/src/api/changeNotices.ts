import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ChangeTopic } from "../generated/ChangeTopic";
import type { LiveConnection } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { stageOptionsKey } from "../stageOptions/stageOptions";
import {
  libraryProblemsQuery,
  micBridgesQuery,
  profileStatsKey,
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
  profiles: [profilesQuery.queryKey, profileStatsKey],
  library: [
    songsKey,
    libraryProblemsQuery.queryKey,
    scanStatusQuery.queryKey,
    profileStatsKey,
  ],
  // Mic settings and Local mics: every such query's key starts with
  // "micSettings" (`localMicsQuery`, `stageOutputMicSettingsQuery`).
  micSettings: [["micSettings"]],
  // Approved and waiting Mic bridges (`micBridgesQuery`).
  micBridges: [micBridgesQuery.queryKey],
  // The mirror's status; #193's USDB search keys start with "usdb" too.
  usdbMirror: [["usdb"]],
  // The Stage options (Setup › Options).
  stageOptions: [stageOptionsKey],
};

const TOPICS = Object.keys(QUERIES_BY_TOPIC) as ChangeTopic[];

/**
 * Keeps the query cache current from the WebSocket: each change notice
 * invalidates the queries its topics name, so the screens showing them
 * refetch and the others refetch when they next open. Each time the socket
 * opens, the first time included, every query is invalidated: notices sent
 * while it was down, or not yet open (a reloaded page fetches over HTTP
 * while its socket opens), are lost. Returns the function that stops it.
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
  let missedNotices = connection !== "open";
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
