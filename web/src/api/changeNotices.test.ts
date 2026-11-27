import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerInfo } from "../generated/ServerInfo";
import type { ServerMessage } from "../generated/ServerMessage";
import { createLiveClient, type LiveSocket } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { api } from "./api";
import { invalidateOnChange } from "./changeNotices";
import { createQueryClient } from "./queryClient";
import { profileQuery, profilesQuery, serverInfoQuery } from "./queries";

/** A stand-in for the browser's WebSocket that the test drives by hand. */
class FakeSocket implements LiveSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {}

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function info(version: string): ServerInfo {
  return { version, schemaVersion: 3, libraryReadOnly: null, publicUrl: null };
}

/** A mocked `fetch` that counts calls per path and answers from `bodies`. */
function mockServer(bodies: Record<string, () => unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      const body = bodies[url];
      return Promise.resolve(
        body
          ? new Response(JSON.stringify(body()), { status: 200 })
          : new Response(null, { status: 404 }),
      );
    }),
  );
  return {
    count: (url: string) => calls.filter((call) => call === url).length,
  };
}

function connect(queryClient: QueryClient) {
  const socket = new FakeSocket();
  const store = createLiveStore((handlers) =>
    createLiveClient({
      url: "ws://test/ws",
      createSocket: () => socket,
      ...handlers,
    }),
  );
  const stop = invalidateOnChange(store, queryClient);
  socket.open();
  return { socket, store, stop };
}

/** Watches a query the way a mounted screen does, until the test ends. */
function watch<T, K extends QueryKey>(
  queryClient: QueryClient,
  options: QueryObserverOptions<T, Error, T, T, K>,
) {
  const observer = new QueryObserver(queryClient, options);
  const latest = { data: undefined as T | undefined };
  const unsubscribe = observer.subscribe((result) => {
    latest.data = result.data;
  });
  cleanups.push(unsubscribe);
  return latest;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("change notices", () => {
  it("refetch exactly the queries their topic names", async () => {
    let version = "1";
    const server = mockServer({
      "/api/server-info": () => info(version),
      "/api/unlock": () => ({ unlocked: false }),
    });
    const queryClient = createQueryClient();
    const { socket } = connect(queryClient);
    const serverInfo = watch(queryClient, serverInfoQuery);
    // A query no topic names in this notice.
    watch(queryClient, {
      queryKey: ["unrelated"],
      queryFn: ({ signal }) => api("GET /api/unlock", { signal }),
    });
    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("1");
    });
    expect(server.count("/api/unlock")).toBe(1);

    version = "2";
    socket.receive({ type: "changed", topics: ["serverInfo"] });

    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("2");
    });
    expect(server.count("/api/server-info")).toBe(2);
    expect(server.count("/api/unlock")).toBe(1);
  });

  it("refetch the list and every single Profile on a Profiles notice", async () => {
    let name = "Ada";
    const profile = (id: number) => ({
      id,
      name,
      avatar: "fox",
      favouriteColour: "sky",
      lastDifficulty: null,
      createdAtMs: 0,
      lastSungAtMs: null,
    });
    const server = mockServer({
      "/api/server-info": () => info("1"),
      "/api/profiles": () => [profile(3)],
      "/api/profiles/3": () => profile(3),
    });
    const queryClient = createQueryClient();
    const { socket } = connect(queryClient);
    const list = watch(queryClient, profilesQuery);
    const one = watch(queryClient, profileQuery(3));
    watch(queryClient, serverInfoQuery);
    await vi.waitFor(() => {
      expect(one.data?.name).toBe("Ada");
      expect(list.data?.[0]?.name).toBe("Ada");
    });

    name = "Grace";
    socket.receive({ type: "changed", topics: ["profiles"] });

    await vi.waitFor(() => {
      expect(one.data?.name).toBe("Grace");
      expect(list.data?.[0]?.name).toBe("Grace");
    });
    expect(server.count("/api/server-info")).toBe(1);
  });

  it("refetch nothing for a notice with no topics", async () => {
    const server = mockServer({ "/api/server-info": () => info("1") });
    const queryClient = createQueryClient();
    const { socket } = connect(queryClient);
    const serverInfo = watch(queryClient, serverInfoQuery);
    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("1");
    });

    socket.receive({ type: "changed", topics: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.count("/api/server-info")).toBe(1);
  });

  it("mark a query no screen shows as stale, to refetch when one opens", async () => {
    const server = mockServer({ "/api/server-info": () => info("1") });
    const queryClient = createQueryClient();
    const { socket } = connect(queryClient);
    await queryClient.query(serverInfoQuery);

    socket.receive({ type: "changed", topics: ["serverInfo"] });

    expect(
      queryClient.getQueryState(serverInfoQuery.queryKey)?.isInvalidated,
    ).toBe(true);
    expect(server.count("/api/server-info")).toBe(1);
  });

  it("refetch every query after the WebSocket reconnects, since notices may have been missed", async () => {
    let version = "1";
    const server = mockServer({
      "/api/server-info": () => info(version),
      "/api/unlock": () => ({ unlocked: false }),
    });
    const queryClient = createQueryClient();
    const sockets: FakeSocket[] = [];
    const store = createLiveStore((handlers) =>
      createLiveClient({
        url: "ws://test/ws",
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        random: () => 0,
        ...handlers,
      }),
    );
    cleanups.push(invalidateOnChange(store, queryClient), () => {
      store.close();
    });
    sockets[0]?.open();
    const serverInfo = watch(queryClient, serverInfoQuery);
    watch(queryClient, {
      queryKey: ["unrelated"],
      queryFn: ({ signal }) => api("GET /api/unlock", { signal }),
    });
    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("1");
    });

    version = "2";
    sockets[0]?.onclose?.();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    sockets[1]?.open();

    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("2");
    });
    await vi.waitFor(() => {
      expect(server.count("/api/unlock")).toBe(2);
    });
  });

  it("refetch what was fetched before the first connection opened, since a notice sent between was missed", async () => {
    // A reloaded page fetches over HTTP while its WebSocket is still
    // opening; the server changes the data and notifies only the sockets
    // already open.
    let version = "1";
    const server = mockServer({ "/api/server-info": () => info(version) });
    const queryClient = createQueryClient();
    const serverInfo = watch(queryClient, serverInfoQuery);
    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("1");
    });
    version = "2";

    connect(queryClient);

    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("2");
    });
    expect(server.count("/api/server-info")).toBe(2);
  });

  it("stop invalidating once stopped", async () => {
    const server = mockServer({ "/api/server-info": () => info("1") });
    const queryClient = createQueryClient();
    const { socket, stop } = connect(queryClient);
    const serverInfo = watch(queryClient, serverInfoQuery);
    await vi.waitFor(() => {
      expect(serverInfo.data?.version).toBe("1");
    });

    stop();
    socket.receive({ type: "changed", topics: ["serverInfo"] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.count("/api/server-info")).toBe(1);
  });
});
