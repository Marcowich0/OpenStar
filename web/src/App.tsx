import { useEffect, useState } from "react";

import type { ServerInfo } from "./generated/ServerInfo";
import type { ServerMessage } from "./generated/ServerMessage";
import { initialRoundTrip, ping, receive, type RoundTrip } from "./roundTrip";

type Info =
  | { status: "loading" }
  | { status: "loaded"; info: ServerInfo }
  | { status: "failed" };

/** The walking skeleton's page: the JSON endpoint's answer and one WebSocket round trip. */
export function App() {
  const [info, setInfo] = useState<Info>({ status: "loading" });
  const [roundTrip, setRoundTrip] = useState<RoundTrip>(initialRoundTrip);

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

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.addEventListener("open", () => {
      setRoundTrip((state) => {
        const next = ping(state, Math.floor(Math.random() * 2 ** 31));
        socket.send(JSON.stringify(next.message));
        return next.state;
      });
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage;
      setRoundTrip((state) => receive(state, message));
    });
    return () => {
      socket.close();
    };
  }, []);

  return (
    <main>
      <h1>OpenStar</h1>
      <p data-testid="server-info">
        {info.status === "loaded"
          ? `Server ${info.info.version}, schema ${String(info.info.schemaVersion)}`
          : info.status}
      </p>
      <p data-testid="round-trip">WebSocket: {roundTrip.status}</p>
    </main>
  );
}
