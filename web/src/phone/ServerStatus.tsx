import { useEffect, useState } from "react";

import type { ServerInfo } from "../generated/ServerInfo";
import { t, type MessageKey } from "../i18n/t";
import { PlaceholderPanel } from "../live/PlaceholderPanel";

type Info =
  | { status: "loading" }
  | { status: "loaded"; info: ServerInfo }
  | { status: "failed" };

const STATUS_TEXT = {
  loading: "server.loading",
  failed: "server.failed",
} as const satisfies Record<Exclude<Info["status"], "loaded">, MessageKey>;

/** The walking skeleton's check: the JSON endpoint's answer and the live state over the WebSocket. */
export function ServerStatus() {
  const [info, setInfo] = useState<Info>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/server-info", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const body = (await response.json()) as ServerInfo;
        setInfo({ status: "loaded", info: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setInfo({ status: "failed" });
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <>
      <p data-testid="server-info">
        {info.status === "loaded"
          ? t("server.version", {
              version: info.info.version,
              schemaVersion: info.info.schemaVersion,
            })
          : t(STATUS_TEXT[info.status])}
      </p>
      <PlaceholderPanel />
    </>
  );
}
