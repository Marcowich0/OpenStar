import type { ClientMessage } from "../generated/ClientMessage";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveConnection } from "./liveState";

/** The part of the browser's `WebSocket` the client uses. */
export interface LiveSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveClientOptions {
  url: string;
  onMessage: (message: ServerMessage) => void;
  onConnection: (connection: LiveConnection) => void;
  /** Defaults to the browser's `WebSocket`. */
  createSocket?: (url: string) => LiveSocket;
  /** Defaults to `Math.random`; spreads the reconnect delays. */
  random?: () => number;
}

export interface LiveClient {
  /** Sends a message; false when the socket is not open. */
  send(message: ClientMessage): boolean;
  /** Closes the socket for good: no more reconnects. */
  close(): void;
}

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5000;
const OPEN = 1;

/**
 * How long to wait before reconnect attempt `attempt` (0-based): doubling
 * from 250 ms up to 5 s, spread down to half that so browsers do not all
 * return at the same moment after a restart.
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number,
): number {
  const full = Math.min(
    MAX_DELAY_MS,
    FIRST_DELAY_MS * 2 ** Math.min(attempt, 16),
  );
  return Math.round(full * (0.5 + random() / 2));
}

/**
 * The browser's one WebSocket. It reconnects by itself, with backoff,
 * whenever the connection drops (a server restart, Wi-Fi trouble); the
 * server's first message on every connection is the whole live state, so
 * nothing else is needed to catch up.
 */
export function createLiveClient(options: LiveClientOptions): LiveClient {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as LiveSocket);
  const random = options.random ?? Math.random;
  let socket: LiveSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function connect() {
    const current = createSocket(options.url);
    socket = current;
    current.onopen = () => {
      attempt = 0;
      options.onConnection("open");
    };
    current.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      options.onMessage(JSON.parse(event.data) as ServerMessage);
    };
    current.onclose = () => {
      if (closed || socket !== current) return;
      options.onConnection("reconnecting");
      retry = setTimeout(connect, reconnectDelayMs(attempt, random));
      attempt += 1;
    };
  }

  options.onConnection("connecting");
  connect();

  return {
    send(message) {
      if (socket?.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}

/** The WebSocket address on the page's own origin. */
export function liveUrl(location: Pick<Location, "protocol" | "host">): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}
