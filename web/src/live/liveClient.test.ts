import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "../generated/ServerMessage";
import {
  createLiveClient,
  liveUrl,
  reconnectDelayMs,
  type LiveSocket,
} from "./liveClient";
import type { LiveConnection } from "./liveState";

/** A stand-in for the browser's WebSocket that the test opens and closes. */
class FakeSocket implements LiveSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  deliver(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function latest(): FakeSocket {
  const socket = FakeSocket.all.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
}

function start() {
  const messages: ServerMessage[] = [];
  const connections: LiveConnection[] = [];
  const client = createLiveClient({
    url: "ws://openstar.test/ws",
    createSocket: (url) => new FakeSocket(url),
    random: () => 1,
    onMessage: (message) => messages.push(message),
    onConnection: (connection) => connections.push(connection),
  });
  return { client, messages, connections };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reconnect delay", () => {
  it("doubles from a quarter second up to five seconds", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 10].map((attempt) =>
      reconnectDelayMs(attempt, () => 1),
    );
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("is spread down to half the delay so browsers do not return in step", () => {
    expect(reconnectDelayMs(2, () => 0)).toBe(500);
  });
});

describe("live client", () => {
  it("hands every server message to the store", () => {
    const { messages } = start();
    latest().open();
    latest().deliver({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: false,
    });
    expect(messages).toEqual([
      { type: "liveState", stageId: "main", party: null, isStage: false },
    ]);
  });

  it("reconnects by itself after the server goes away, with growing delays", () => {
    const { connections } = start();
    latest().open();
    latest().drop();
    expect(connections).toEqual(["connecting", "open", "reconnecting"]);
    expect(FakeSocket.all).toHaveLength(1);

    vi.advanceTimersByTime(249);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);

    // The server is still down: the next try waits longer.
    latest().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    expect(latest().url).toBe("ws://openstar.test/ws");
  });

  it("starts the delays over once a connection has opened", () => {
    start();
    latest().drop();
    vi.advanceTimersByTime(250);
    latest().drop();
    vi.advanceTimersByTime(500);
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("is told the state again by the server after reconnecting", () => {
    const { messages, connections } = start();
    latest().open();
    latest().deliver({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: false,
    });
    latest().drop();
    vi.advanceTimersByTime(250);
    latest().open();
    latest().deliver({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: true,
    });
    expect(connections.at(-1)).toBe("open");
    expect(messages.at(-1)).toEqual({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: true,
    });
  });

  it("sends only while open", () => {
    const { client } = start();
    expect(client.send({ type: "ping", nonce: 1 })).toBe(false);
    latest().open();
    expect(client.send({ type: "ping", nonce: 2 })).toBe(true);
    expect(latest().sent).toEqual(['{"type":"ping","nonce":2}']);
  });

  it("stops reconnecting once closed", () => {
    const { client } = start();
    latest().open();
    client.close();
    latest().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("waits for beforeConnect before every connection", async () => {
    let allow: () => void = () => undefined;
    const beforeConnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          allow = resolve;
        }),
    );
    createLiveClient({
      url: "ws://openstar.test/ws/stage",
      createSocket: (url) => new FakeSocket(url),
      random: () => 1,
      beforeConnect,
      onMessage: () => undefined,
      onConnection: () => undefined,
    });
    expect(beforeConnect).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(0);
    allow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(1);

    latest().drop();
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(1);
    allow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("opens no socket once closed while beforeConnect waits", async () => {
    let allow: () => void = () => undefined;
    const client = createLiveClient({
      url: "ws://openstar.test/ws/stage",
      createSocket: (url) => new FakeSocket(url),
      beforeConnect: () =>
        new Promise<void>((resolve) => {
          allow = resolve;
        }),
      onMessage: () => undefined,
      onConnection: () => undefined,
    });
    client.close();
    allow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe("liveUrl", () => {
  const at = (pathname: string, protocol = "http:") =>
    liveUrl({ protocol, host: "openstar.test", pathname });

  it("opens the Stage's WebSocket from the Stage's page only", () => {
    expect(at("/stage")).toBe("ws://openstar.test/ws/stage");
    expect(at("/stage/")).toBe("ws://openstar.test/ws/stage");
    expect(at("/")).toBe("ws://openstar.test/ws");
    expect(at("/admin")).toBe("ws://openstar.test/ws");
    expect(at("/stagehand")).toBe("ws://openstar.test/ws");
  });

  it("uses wss on an HTTPS page", () => {
    expect(at("/stage", "https:")).toBe("wss://openstar.test/ws/stage");
  });
});
