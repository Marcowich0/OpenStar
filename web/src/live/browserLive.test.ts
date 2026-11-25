import { afterAll, describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "../generated/ServerMessage";
import { liveStore, readLive } from "./browserLive";

class FakeWebSocket {
  static made: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this);
  }
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

vi.stubGlobal("WebSocket", FakeWebSocket);
afterAll(() => {
  liveStore().close();
  vi.unstubAllGlobals();
});

describe("the browser's live store", () => {
  it("is one store with one WebSocket, however often a route asks for it", () => {
    const first = liveStore();
    const second = liveStore();

    expect(second).toBe(first);
    expect(FakeWebSocket.made).toHaveLength(1);
    expect(FakeWebSocket.made[0]?.url).toBe(`ws://${window.location.host}/ws`);
  });

  it("can be read synchronously, without a subscription, as a render loop does", () => {
    const socket = FakeWebSocket.made[0];
    socket?.open();
    socket?.receive({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: false,
    });

    const state = readLive();
    expect(state.connection).toBe("open");
    expect(state.stage).toEqual({
      stageId: "main",
      party: null,
      isStage: false,
      stageMoved: false,
    });
  });
});
