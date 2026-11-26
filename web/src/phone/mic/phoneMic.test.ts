import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../../generated/ClientMessage";
import type { ClockPongFields } from "../../pitch/clock/senderSession";
import {
  fakeContext,
  fakeMedia,
  fakePitchNodes,
  fakeTime,
  pipelineOptions,
} from "../../pitch/capture/testCapture";
import { createPhoneMic } from "./phoneMic";

/** A fake socket to a Stage 1000 ms ahead that answers each ping at once. */
function fakeStore(time: ReturnType<typeof fakeTime>) {
  const sent: ClientMessage[] = [];
  const listeners = new Set<(pong: ClockPongFields) => void>();
  return {
    sent,
    send(message: ClientMessage) {
      sent.push(message);
      if (message.type === "clockPing") {
        const pong = { t0: message.t0, ts: time.now() + 1000, epoch: 77 };
        for (const listener of listeners) listener(pong);
      }
      return true;
    },
    onClockPong(listener: (pong: ClockPongFields) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function setUp(refuse?: Error) {
  const time = fakeTime(1000);
  const store = fakeStore(time);
  const nodes = fakePitchNodes();
  const media = fakeMedia(refuse);
  const capture = await pipelineOptions({
    time,
    createPitchNode: nodes.create,
    getUserMedia: media.getUserMedia,
    createContext: () => fakeContext(48000),
  });
  const mic = createPhoneMic({
    store,
    capture,
    measureCost: () =>
      Promise.resolve({ windows: 200, p50Ms: 0.4, p95Ms: 0.9 }),
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { time, store, nodes, media, mic };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Phone's mic", () => {
  it("is off until the tap", async () => {
    const { mic, media, store } = await setUp();
    expect(mic.getSnapshot().state).toBe("off");
    expect(media.constraints).toHaveLength(0);
    expect(store.sent).toHaveLength(0);
  });

  it("opens on the tap, syncs, and sends one message per reading", async () => {
    const { mic, store, nodes, time } = await setUp();
    mic.turnOn();
    expect(mic.getSnapshot().state).toBe("opening");
    await settle();
    expect(mic.getSnapshot().state).toBe("on");

    time.advanceTo(1200);
    expect(store.sent[0]).toMatchObject({ type: "clockPing" });
    for (let k = 0; k < 3; k++) {
      nodes.emit({
        pitch: k === 1 ? null : 69,
        clarity: 0.9,
        loudness: -20,
        endFrame: 48000 + 512 * k,
        sampleRate: 48000,
      });
    }
    const readings = store.sent.filter((m) => m.type === "pitchReading");
    expect(readings).toHaveLength(3);
    expect(readings[1]).toMatchObject({
      type: "pitchReading",
      reading: { pitch: null, clarity: 0.9, loudness: -20 },
    });
    // On the Stage's clock: 1000 ms ahead of this page's.
    const first = readings[0];
    if (first?.type !== "pitchReading") throw new Error("no reading");
    expect(first.reading.captureMs).toBeGreaterThan(2000);
    mic.turnOff();
    expect(mic.getSnapshot().state).toBe("off");
  });

  it("shows readings per second and the detector's cost", async () => {
    const { mic, nodes, time } = await setUp();
    mic.turnOn();
    await settle();
    // About 94 a second, from 1.2 s to 3 s on the page's clock.
    for (let k = 0; 1200 + (k * 512) / 48 <= 3000; k++) {
      time.advanceTo(1200 + (k * 512) / 48);
      nodes.emit({
        pitch: 69,
        clarity: 0.9,
        loudness: -20,
        endFrame: 48000 + 512 * k,
        sampleRate: 48000,
      });
    }
    time.advanceTo(3000);
    expect(mic.getSnapshot()).toMatchObject({
      state: "on",
      detector: { p50Ms: 0.4, p95Ms: 0.9 },
    });
    // The readout refreshed at 3 s: the readings of (2 s, 3 s].
    expect(mic.getSnapshot().readingsPerSecond).toBe(93);
    mic.turnOff();
  });

  it("fails when the mic cannot open, and a second tap tries again", async () => {
    const { mic, media } = await setUp(
      new DOMException("denied", "NotAllowedError"),
    );
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot().state).toBe("failed");
    mic.turnOn();
    expect(media.constraints).toHaveLength(2);
  });

  it("ignores a tap while it is opening or on", async () => {
    const { mic, media } = await setUp();
    mic.turnOn();
    mic.turnOn();
    await settle();
    mic.turnOn();
    expect(media.constraints).toHaveLength(1);
    mic.turnOff();
  });
});
