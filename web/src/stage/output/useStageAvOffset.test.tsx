import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AvOffset } from "../../generated/AvOffset";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import { StageOutputProvider } from "./StageOutput";
import type { StageOutputWatcher } from "./stageOutput";
import { useStageAvOffset, type StageAvOffset } from "./useStageAvOffset";

function fakeWatcher() {
  let key: string | null = null;
  const listeners = new Set<() => void>();
  const watcher: StageOutputWatcher & { read: (next: string) => void } = {
    start: () => {},
    stop: () => {},
    current: () => key,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onOutputChanged: () => () => {},
    read(next) {
      key = next;
      for (const listener of listeners) listener();
    },
  };
  return watcher;
}

/** The server's kept A/V offsets of browser `stage-1`, by output key. */
function serverKeeps(kept: Record<string, number>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://openstar.test");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as AvOffset;
      kept[body.output] = body.avOffsetMs;
      return Promise.resolve(Response.json(body));
    }
    const browser = url.searchParams.get("browser") ?? "";
    const output = url.searchParams.get("output") ?? "";
    return Promise.resolve(
      Response.json({
        browser,
        output,
        avOffsetMs: browser === "stage-1" ? (kept[output] ?? 0) : 0,
      } satisfies AvOffset),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const watcher = fakeWatcher();
  let offset: StageAvOffset | null = null;
  function Probe() {
    offset = useStageAvOffset();
    return null;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StageOutputProvider
        store={store}
        makeWatcher={() => watcher}
        storage={() => ({ getItem: () => "stage-1", setItem: () => {} })}
      >
        <Probe />
      </StageOutputProvider>
    </QueryClientProvider>,
  );
  act(() => {
    handlers?.onConnection("open");
    handlers?.onMessage({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: true,
    });
  });
  return {
    watcher,
    offset: () => {
      if (!offset) throw new Error("not rendered");
      return offset;
    },
  };
}

describe("the Stage's A/V offset", () => {
  it("is 0 while the output is unknown", () => {
    const fetchMock = serverKeeps({});
    const t = setup();
    expect(t.offset().ms).toBe(0);
    expect(t.offset().seconds()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the current output's value, and that of each output it changes to", async () => {
    const fetchMock = serverKeeps({ Speakers: 120, "HDMI (LG TV)": -40 });
    const t = setup();

    act(() => t.watcher.read("Speakers"));
    await waitFor(() => expect(t.offset().ms).toBe(120));
    expect(t.offset().seconds()).toBeCloseTo(0.12, 9);
    const asked = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "http://openstar.test",
    );
    expect(asked.pathname).toBe("/api/av-offset");
    expect(asked.searchParams.get("browser")).toBe("stage-1");
    expect(asked.searchParams.get("output")).toBe("Speakers");

    // A new output never draws with the old output's value meanwhile.
    act(() => t.watcher.read("HDMI (LG TV)"));
    expect(t.offset().ms).toBe(0);
    await waitFor(() => expect(t.offset().ms).toBe(-40));

    // An output nothing is kept for starts at 0.
    act(() => t.watcher.read("JBL Flip"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(t.offset().ms).toBe(0);
  });

  it("saves a new value for the current output, which reads it back at once", async () => {
    const kept: Record<string, number> = {};
    const fetchMock = serverKeeps(kept);
    const t = setup();
    act(() => t.watcher.read("Speakers"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(() => t.offset().save(200));
    expect(kept).toEqual({ Speakers: 200 });
    expect(t.offset().ms).toBe(200);
    const [, init] = fetchMock.mock.calls[1] ?? [];
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      browser: "stage-1",
      output: "Speakers",
      avOffsetMs: 200,
    });
  });

  it("keeps a value it would save within -300..+500 ms on the 10 ms grid", async () => {
    const kept: Record<string, number> = {};
    serverKeeps(kept);
    const t = setup();
    act(() => t.watcher.read("Speakers"));
    await act(() => t.offset().save(640));
    expect(kept.Speakers).toBe(500);
    await act(() => t.offset().save(-1000));
    expect(kept.Speakers).toBe(-300);
    await act(() => t.offset().save(123));
    expect(kept.Speakers).toBe(120);
  });
});
