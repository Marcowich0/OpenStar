import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { ServerMessage } from "../../generated/ServerMessage";
import type { LiveClientOptions } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import {
  StageOutputProvider,
  useStageOutput,
  type StageOutputApi,
} from "./StageOutput";
import type { StageOutputWatcher } from "./stageOutput";

function fakeWatcher() {
  let key: string | null = null;
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(key: string, previous: string) => void>();
  const watcher: StageOutputWatcher & { read: (next: string) => void } = {
    start: vi.fn(),
    stop: vi.fn(() => {
      key = null;
      for (const listener of listeners) listener();
    }),
    current: () => key,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onOutputChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    read(next) {
      const previous = key;
      key = next;
      for (const listener of listeners) listener();
      if (previous !== null && previous !== next) {
        for (const listener of changeListeners) listener(next, previous);
      }
    },
  };
  return watcher;
}

function setup() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const watchers: ReturnType<typeof fakeWatcher>[] = [];
  const makeWatcher = vi.fn(() => {
    const made = fakeWatcher();
    watchers.push(made);
    return made;
  });
  let api: StageOutputApi | null = null;
  function Probe() {
    api = useStageOutput();
    return null;
  }
  render(
    <StageOutputProvider
      store={store}
      makeWatcher={makeWatcher}
      storage={() => ({ getItem: () => "stage-1", setItem: () => {} })}
    >
      <Probe />
    </StageOutputProvider>,
  );
  const server = (message: ServerMessage) => {
    act(() => handlers?.onMessage(message));
  };
  const connection = (state: "open" | "reconnecting") => {
    act(() => handlers?.onConnection(state));
  };
  const becomeStage = () => {
    connection("open");
    server({ type: "liveState", stageId: "main", party: null, isStage: true });
  };
  const reports = () => sent.filter((m) => m.type === "reportStageOutput");
  return {
    server,
    connection,
    becomeStage,
    reports,
    watchers,
    makeWatcher,
    api: () => api,
  };
}

describe("StageOutputProvider", () => {
  it("watches nothing while this browser is not the Stage", () => {
    const t = setup();
    t.connection("open");
    t.server({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: false,
    });
    expect(t.watchers[0]?.start).not.toHaveBeenCalled();
    expect(t.api()?.outputKey).toBeNull();
  });

  it("reports the output key once it is read, and again on every change", () => {
    const t = setup();
    t.becomeStage();
    expect(t.watchers[0]?.start).toHaveBeenCalledTimes(1);
    expect(t.reports()).toEqual([]);

    act(() => t.watchers[0]?.read("Speakers (Scarlett 4i4)"));
    expect(t.api()?.outputKey).toBe("Speakers (Scarlett 4i4)");
    expect(t.reports()).toEqual([
      {
        type: "reportStageOutput",
        stageBrowser: "stage-1",
        stageOutput: "Speakers (Scarlett 4i4)",
      },
    ]);

    act(() => t.watchers[0]?.read("HDMI (LG TV)"));
    expect(
      t.reports().map((m) => ("stageOutput" in m ? m.stageOutput : null)),
    ).toEqual(["Speakers (Scarlett 4i4)", "HDMI (LG TV)"]);
  });

  it("passes the output-changed event on to its listeners", () => {
    const t = setup();
    t.becomeStage();
    const changed = vi.fn();
    act(() => {
      t.api()?.onOutputChanged(changed);
    });
    act(() => t.watchers[0]?.read("Speakers"));
    expect(changed).not.toHaveBeenCalled();
    act(() => t.watchers[0]?.read("HDMI (LG TV)"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("HDMI (LG TV)", "Speakers");
  });

  it("reports again after the WebSocket reconnects", () => {
    const t = setup();
    t.becomeStage();
    act(() => t.watchers[0]?.read("Speakers"));
    t.connection("reconnecting");
    t.becomeStage();
    expect(t.reports()).toHaveLength(2);
  });

  it("stops watching when another browser becomes the Stage", () => {
    const t = setup();
    t.becomeStage();
    t.server({ type: "stageMoved" });
    expect(t.watchers[0]?.stop).toHaveBeenCalled();
    expect(t.api()?.outputKey).toBeNull();
  });
});
