import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "../generated/ServerMessage";
import { createPitchRouter } from "../pitch/pitchRouter";
import type { LiveClientOptions } from "./liveClient";
import { receive, type LiveState } from "./liveState";
import { createLiveStore, type LiveStore } from "./liveStore";
import { useLive } from "./useLive";

// Count every reducer call, keeping the real reducer.
vi.mock("./liveState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./liveState")>();
  return { ...actual, receive: vi.fn(actual.receive) };
});

const wholeState = (state: LiveState) => state;

function Probe({
  store,
  rendered,
}: {
  store: LiveStore;
  rendered: () => void;
}) {
  useLive(wholeState, store);
  rendered();
  return null;
}

function start() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const router = createPitchRouter();
  const store = createLiveStore(
    (given) => {
      handlers = given;
      return { send: () => true, close: () => {} };
    },
    undefined,
    router,
  );
  const server = (message: ServerMessage) => {
    act(() => handlers?.onMessage(message));
  };
  return { store, router, server };
}

const pitchReading = (
  connection: number,
  captureMs: number,
): ServerMessage => ({
  type: "pitchReading",
  mic: { kind: "phone", connection },
  reading: { captureMs, pitch: 60, clarity: 0.9, loudness: -20 },
});

describe("Pitch readings in the live store", () => {
  it("go into their Player's buffer without the reducer or a render", () => {
    const { store, router, server } = start();
    const buffers = router.start({
      players: 2,
      mics: [[{ kind: "phone", connection: 4 }, 1]],
      capacity: 16,
      place: (reading) => reading.captureMs / 1000,
    });
    const rendered = vi.fn();
    render(<Probe store={store} rendered={rendered} />);
    const listener = vi.fn();
    store.subscribe(listener);
    const rendersBefore = rendered.mock.calls.length;
    vi.mocked(receive).mockClear();

    for (let i = 0; i < 100; i++) server(pitchReading(4, i * 10));

    expect(buffers[1]?.size).toBe(16);
    expect(buffers[1]?.newestSongTime()).toBe(0.99);
    expect(buffers[0]?.size).toBe(0);
    expect(receive).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(rendered.mock.calls.length).toBe(rendersBefore);
  });

  it("from a Mic assigned to no Player are dropped, still without the reducer", () => {
    const { router, server } = start();
    const buffers = router.start({
      players: 1,
      mics: [[{ kind: "phone", connection: 1 }, 0]],
      capacity: 16,
      place: (reading) => reading.captureMs / 1000,
    });
    vi.mocked(receive).mockClear();

    server(pitchReading(9, 0));

    expect(buffers[0]?.size).toBe(0);
    expect(receive).not.toHaveBeenCalled();
  });

  it("leave every other message to the reducer", () => {
    const { server } = start();
    vi.mocked(receive).mockClear();
    server({ type: "micClosed", mic: { kind: "phone", connection: 1 } });
    expect(receive).toHaveBeenCalledTimes(1);
  });
});

describe("Mic bridge levels in the live store", () => {
  it("go to their listeners without the reducer or a render", () => {
    const { store, server } = start();
    const rendered = vi.fn();
    render(<Probe store={store} rendered={rendered} />);
    const heard = vi.fn();
    const stop = store.onLocalMicLevels(heard);
    const rendersBefore = rendered.mock.calls.length;
    vi.mocked(receive).mockClear();

    const levels = [{ localMicId: "bridge:b:x.wav:0", levelDbfs: -12 }];
    server({ type: "localMicLevels", levels });

    expect(heard).toHaveBeenCalledWith(levels);
    expect(receive).not.toHaveBeenCalled();
    expect(rendered.mock.calls.length).toBe(rendersBefore);

    stop();
    server({ type: "localMicLevels", levels });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
