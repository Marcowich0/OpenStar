// A fake OpenStar server for the guarded-action tests: the Unlock endpoints,
// one guarded endpoint (`POST /api/unlock/heartbeat`, guarded on the real
// server too), and `GET /api/server-info` with a settable read-only Library.
// It answers the way `crates/server` does: `401 unlockRequired` without an
// Unlock, `409 libraryReadOnly` for a Library write while read-only.

import { vi } from "vitest";

import type { LibraryReadOnly } from "../generated/LibraryReadOnly";

export const ADMIN_PIN = "4321";

export interface FakeServer {
  unlocked: boolean;
  libraryReadOnly: LibraryReadOnly | null;
  /** Every call, as `"METHOD /path"`, in order. */
  calls: string[];
  /** How many times `route` was called. */
  count: (route: string) => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function fakeServer(
  start: Partial<Pick<FakeServer, "unlocked" | "libraryReadOnly">> = {},
): FakeServer {
  const server: FakeServer = {
    unlocked: start.unlocked ?? false,
    libraryReadOnly: start.libraryReadOnly ?? null,
    calls: [],
    count: (route) => server.calls.filter((call) => call === route).length,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const route = `${init.method ?? "GET"} ${url}`;
      server.calls.push(route);
      switch (route) {
        case "GET /api/unlock":
          return Promise.resolve(json(200, { unlocked: server.unlocked }));
        case "POST /api/unlock": {
          const { pin } = JSON.parse(init.body as string) as { pin: string };
          if (pin !== ADMIN_PIN)
            return Promise.resolve(json(403, { code: "wrongPin" }));
          server.unlocked = true;
          return Promise.resolve(json(200, { unlocked: true }));
        }
        case "POST /api/lock":
          server.unlocked = false;
          return Promise.resolve(json(200, { unlocked: false }));
        case "POST /api/unlock/heartbeat":
          return Promise.resolve(
            server.unlocked
              ? json(200, { unlocked: true })
              : json(401, { code: "unlockRequired" }),
          );
        case "GET /api/server-info":
          return Promise.resolve(
            json(200, {
              version: "dev",
              schemaVersion: 1,
              libraryReadOnly: server.libraryReadOnly,
              publicUrl: null,
            }),
          );
        default:
          return Promise.resolve(json(404, {}));
      }
    }),
  );
  return server;
}
