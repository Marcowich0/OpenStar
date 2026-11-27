// Reconnect and resync end to end on the Phone (#129): the real live client
// and store over a fake WebSocket, and the real Phone mic and capture clock
// on fake media.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { ServerMessage } from "../../generated/ServerMessage";
import { createLiveClient, type LiveSocket } from "../../live/liveClient";
import { createLiveStore } from "../../live/liveStore";
import {
  fakePitchNodes,
  fakeTime,
  pipelineOptions,
} from "../../pitch/capture/testCapture";
import { createPhoneMic } from "./phoneMic";
import { onReconnect } from "./reconnect";

/** A stand-in for the browser's WebSocket that the test opens and drops. */
class FakeSocket implements LiveSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: ClientMessage[] = [];
  readyState = 0;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
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

const latest = () => {
  const socket = FakeSocket.all.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
};

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function phoneStore() {
  return createLiveStore(
    (handlers) =>
      createLiveClient({
        url: "ws://stage/ws",
        createSocket: () => new FakeSocket(),
        random: () => 0,
        ...handlers,
      }),
    () => ({ type: "hello", phoneId: "mia-phone" }),
  );
}

describe("onReconnect", () => {
  it("fires each time the socket is open again after a drop, never on the first open", () => {
    const store = phoneStore();
    const listener = vi.fn();
    onReconnect(store, listener);
    latest().open();
    expect(listener).not.toHaveBeenCalled();
    latest().drop();
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(listener).toHaveBeenCalledTimes(1);
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(listener).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("stops after the unsubscribe", () => {
    const store = phoneStore();
    const listener = vi.fn();
    const stop = onReconnect(store, listener);
    latest().open();
    stop();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(listener).not.toHaveBeenCalled();
    store.close();
  });
});

describe("a Phone's mic over a dropped WebSocket", () => {
  it("presents its Phone id again, then resyncs with fast pings before any reading leaves", async () => {
    const time = fakeTime(1000);
    const nodes = fakePitchNodes();
    const store = phoneStore();
    const mic = createPhoneMic({
      store: {
        send: store.send,
        onClockPong: store.onClockPong,
        onReconnect: (listener) => onReconnect(store, listener),
      },
      capture: await pipelineOptions({ time, createPitchNode: nodes.create }),
      measureCost: () => new Promise(() => undefined),
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    /** The Stage, 1000 ms ahead, answers every ping on `socket` at once. */
    const answerPings = (socket: FakeSocket, from: number) => {
      for (const message of socket.sent.slice(from)) {
        if (message.type === "clockPing")
          socket.deliver({
            type: "clockPong",
            t0: message.t0,
            ts: time.now() + 1000,
            epoch: 5,
          });
      }
      return socket.sent.length;
    };
    const readingsOn = (socket: FakeSocket) =>
      socket.sent.filter((m) => m.type === "pitchReading");
    const emit = (k: number) => {
      nodes.emit({
        pitch: 69,
        clarity: 0.9,
        loudness: -20,
        endFrame: 48000 + 512 * k,
        sampleRate: 48000,
      });
    };

    const first = latest();
    first.open();
    mic.turnOn();
    await vi.advanceTimersByTimeAsync(0);
    time.advanceTo(1200);
    answerPings(first, 0);
    emit(0);
    expect(readingsOn(first)).toHaveLength(1);

    first.drop();
    time.advanceTo(5000);
    await vi.advanceTimersByTimeAsync(1000);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    // The Phone id first, so the server knows it as the same Player again.
    expect(second.sent[0]).toEqual({ type: "hello", phoneId: "mia-phone" });

    // No offset yet on this connection: the reading is dropped.
    emit(1);
    expect(readingsOn(second)).toHaveLength(0);
    time.advanceTo(5200);
    const pings = second.sent.filter((m) => m.type === "clockPing");
    expect(pings).toHaveLength(1);
    answerPings(second, 0);
    emit(2);
    expect(readingsOn(second)).toHaveLength(1);
    // Fast pings, 200 ms apart, for 5 s after the reconnect.
    let seen = second.sent.length;
    for (let at = 5400; at <= 10_000; at += 200) {
      time.advanceTo(at);
      seen = answerPings(second, seen);
    }
    expect(second.sent.filter((m) => m.type === "clockPing")).toHaveLength(25);
    mic.turnOff();
    store.close();
  });
});
