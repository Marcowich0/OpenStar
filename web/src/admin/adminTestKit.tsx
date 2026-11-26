// Test kit for the Admin area's sections: a stubbed `fetch` with
// settable answers, and a fake WebSocket whose change notices reach the
// query cache through the app's own `invalidateOnChange`.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

import { invalidateOnChange } from "../api/changeNotices";
import { createQueryClient } from "../api/queryClient";
import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ServerMessage } from "../generated/ServerMessage";
import { createLiveClient, type LiveSocket } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";

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

/**
 * A body, or a function of the URL (and the request) that gives one, or a
 * promise of one. A `Response` is sent as it is (a status other than 200).
 */
type Answer = unknown;

export interface FakeLibraryServer {
  /** Answers by `"METHOD /path"` (no query); a function gets the URL. */
  answers: Record<string, Answer>;
  /** Every call, as `"METHOD /path?query"`, in order. */
  calls: string[];
  count: (route: string) => number;
}

export function fakeLibraryServer(
  answers: Record<string, Answer>,
): FakeLibraryServer {
  const server: FakeLibraryServer = {
    answers: {
      "GET /api/server-info": {
        version: "dev",
        schemaVersion: 1,
        libraryReadOnly: null,
        publicUrl: null,
      },
      "GET /api/unlock": { unlocked: false },
      ...answers,
    },
    calls: [],
    count: (route) => server.calls.filter((call) => call === route).length,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, "http://test");
      const method = init.method ?? "GET";
      server.calls.push(`${method} ${url.pathname}${url.search}`);
      const answer = server.answers[`${method} ${url.pathname}`];
      if (answer === undefined)
        return Promise.resolve(new Response(null, { status: 404 }));
      const body =
        typeof answer === "function"
          ? (answer as (url: URL, init: RequestInit) => unknown)(url, init)
          : answer;
      return Promise.resolve(body).then((resolved) =>
        resolved instanceof Response
          ? resolved
          : new Response(JSON.stringify(resolved), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
      );
    }),
  );
  return server;
}

/** Renders `ui` with a query client kept current by a fake WebSocket. */
export async function renderLive(ui: ReactNode) {
  const queryClient = createQueryClient();
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
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  await settle();
  return {
    stop,
    /** Delivers `Changed { topics }`, as the server sends it. */
    async changed(...topics: ChangeTopic[]) {
      act(() => {
        socket.receive({ type: "changed", topics });
      });
      await settle();
    },
  };
}

export async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
