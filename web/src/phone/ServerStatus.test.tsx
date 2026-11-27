import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateOnChange } from "../api/changeNotices";
import { createQueryClient } from "../api/queryClient";
import type { ServerInfo } from "../generated/ServerInfo";
import type { ServerMessage } from "../generated/ServerMessage";
import { t } from "../i18n/t";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { ServerStatus } from "./ServerStatus";

function info(version: string): ServerInfo {
  return { version, schemaVersion: 3, libraryReadOnly: null, publicUrl: null };
}

function serverAnswers(answer: () => Response) {
  const fetchMock = vi.fn(() => Promise.resolve(answer()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Renders the screen with a live store whose server the test plays. */
function renderStatus() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const queryClient = createQueryClient();
  const stop = invalidateOnChange(store, queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <ServerStatus store={store} />
    </QueryClientProvider>,
  );
  return {
    stop,
    server: (message: ServerMessage) => {
      act(() => {
        handlers?.onMessage(message);
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the skeleton's server status", () => {
  it("shows the server info it read through the query", async () => {
    serverAnswers(() => Response.json(info("1.2.0")));

    const { stop } = renderStatus();

    expect(await screen.findByText(/1\.2\.0/)).toBeInTheDocument();
    stop();
  });

  it("shows the new value when a change notice arrives, without a reload", async () => {
    let version = "1.2.0";
    const fetchMock = serverAnswers(() => Response.json(info(version)));
    const { server, stop } = renderStatus();
    expect(await screen.findByText(/1\.2\.0/)).toBeInTheDocument();

    version = "1.3.0";
    server({ type: "changed", topics: ["serverInfo"] });

    expect(await screen.findByText(/1\.3\.0/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it("says so when the server cannot be read", async () => {
    serverAnswers(() => new Response(null, { status: 500 }));

    const { stop } = renderStatus();

    await vi.waitFor(() => {
      expect(screen.getByTestId("server-info")).toHaveTextContent(
        t("server.failed"),
      );
    });
    stop();
  });
});
