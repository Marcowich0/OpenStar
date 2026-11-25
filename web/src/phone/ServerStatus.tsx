import { useEffect, useState } from "react";

import type { ServerInfo } from "../generated/ServerInfo";
import { PlaceholderPanel } from "../live/PlaceholderPanel";

type Info =
  | { status: "loading" }
  | { status: "loaded"; info: ServerInfo }
  | { status: "failed" };

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
          ? `Server ${info.info.version}, schema ${String(info.info.schemaVersion)}`
          : info.status}
      </p>
      <PlaceholderPanel />
    </>
  );
}
