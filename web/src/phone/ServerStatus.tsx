import { useQuery } from "@tanstack/react-query";

import { serverInfoQuery } from "../api/queries";
import { t } from "../i18n/t";
import { PartyPanel } from "../live/PartyPanel";
import type { LiveStore } from "../live/liveStore";
import { liveStore } from "../live/useLive";

/**
 * The walking skeleton's check: the JSON endpoint's answer, read through a
 * query that a `serverInfo` change notice refreshes, and the live state over
 * the WebSocket.
 */
export function ServerStatus({ store = liveStore() }: { store?: LiveStore }) {
  const info = useQuery(serverInfoQuery);

  return (
    <>
      <p data-testid="server-info">
        {info.isSuccess
          ? t("server.version", {
              version: info.data.version,
              schemaVersion: info.data.schemaVersion,
            })
          : t(info.isError ? "server.failed" : "server.loading")}
      </p>
      <PartyPanel store={store} />
    </>
  );
}
