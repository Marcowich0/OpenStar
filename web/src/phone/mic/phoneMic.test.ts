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
import { createPhoneMic, MediaDevicesMissingError } from "./phoneMic";

/**
 * A fake socket to a Stage 1000 ms ahead that answers each ping at once.
 * `drop()` takes it down (nothing is sent), `reconnect()` opens it again.
 */
function fakeStore(time: ReturnType<typeof fakeTime>) {
  const sent: ClientMessage[] = [];
  const listeners = new Set<(pong: ClockPongFields) => void>();
  const reconnectListeners = new Set<() => void>();
  let up = true;
  return {
    sent,
    send(message: ClientMessage) {
      if (!up) return false;
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
    onReconnect(listener: () => void) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
    drop() {
      up = false;
    },
    reconnect() {
      up = true;
      for (const listener of [...reconnectListeners]) listener();
    },
  };
}

/** A page whose visibility the test flips, like `document.visibilityState`. */
function fakePage() {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: "hidden" | "visible") {
      hidden = next === "hidden";
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The screen Wake Lock: counts requests and releases, or refuses. */
function fakeWakeLock() {
  const lock = {
    requests: 0,
    held: 0,
    refuse: false,
    request: () => {
      lock.requests += 1;
      if (lock.refuse)
        return Promise.reject(new DOMException("no", "NotAllowedError"));
      lock.held += 1;
      return Promise.resolve({
        release: () => {
          lock.held -= 1;
          return Promise.resolve();
        },
      });
    },
  };
  return lock;
}

async function setUp(
  refuse?: Error,
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>,
) {
  const time = fakeTime(1000);
  const page = fakePage();
  const wakeLock = fakeWakeLock();
  const store = fakeStore(time);
  const nodes = fakePitchNodes();
  const media = fakeMedia(refuse);
  const capture = await pipelineOptions({
    time,
    createPitchNode: nodes.create,
    getUserMedia: getUserMedia ?? media.getUserMedia,
    createContext: () => fakeContext(48000),
  });
  const mic = createPhoneMic({
    store,
    capture,
    measureCost: () =>
      Promise.resolve({ windows: 200, p50Ms: 0.4, p95Ms: 0.9 }),
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    page,
    wakeLock: wakeLock.request,
  });
  return { time, store, nodes, media, mic, page, wakeLock };
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

/** A worklet reading at frame `endFrame`, made `afterMs` after the frame. */
function reading(endFrame: number) {
  return {
    pitch: 69,
    clarity: 0.9,
    loudness: -20,
    endFrame,
    sampleRate: 48000,
  };
}

const sentReadings = (sent: ClientMessage[]) =>
  sent.flatMap((m) => (m.type === "pitchReading" ? [m.reading] : []));

describe("the Phone's mic lifecycle", () => {
  it("sends readings as soon as it is open, before any Song starts", async () => {
    // The Phone knows nothing of Start: an open mic sends all the time,
    // so its loudness can drive the seat's meter.
    const { mic, store, nodes, time } = await setUp();
    mic.turnOn();
    await settle();
    time.advanceTo(1200);
    nodes.emit(reading(48000));
    expect(sentReadings(store.sent)).toHaveLength(1);
    mic.turnOff();
  });

  it("requests the screen Wake Lock on the tap and lets it go on release", async () => {
    const { mic, wakeLock } = await setUp();
    mic.turnOn();
    expect(wakeLock.requests).toBe(1);
    await settle();
    expect(wakeLock.held).toBe(1);
    mic.turnOff();
    await settle();
    expect(wakeLock.held).toBe(0);
  });

  it("keeps working when the Wake Lock is refused", async () => {
    const { mic, wakeLock, store, nodes, time } = await setUp();
    wakeLock.refuse = true;
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot().state).toBe("on");
    time.advanceTo(1200);
    nodes.emit(reading(48000));
    expect(sentReadings(store.sent)).toHaveLength(1);
    mic.turnOff();
  });

  it("stops sending and tells the Stage when the page is hidden", async () => {
    const { mic, store, nodes, time, page, media } = await setUp();
    mic.turnOn();
    await settle();
    time.advanceTo(1200);
    nodes.emit(reading(48000));
    page.set("hidden");
    expect(mic.getSnapshot().state).toBe("lost");
    expect(store.sent.at(-1)).toEqual({ type: "micPage", visible: false });
    // The mic is released: nothing more leaves, even if the node still posts.
    expect(media.stopped).toBe(1);
    nodes.emit(reading(48512));
    expect(sentReadings(store.sent)).toHaveLength(1);
  });

  it("does nothing when the page hides while the mic is off", async () => {
    const { mic, store, page } = await setUp();
    page.set("hidden");
    page.set("visible");
    expect(mic.getSnapshot().state).toBe("off");
    expect(store.sent).toHaveLength(0);
  });

  it("asks for the Wake Lock again each time the page is visible again, and reports it visible", async () => {
    const { mic, store, page, wakeLock } = await setUp();
    mic.turnOn();
    await settle();
    page.set("hidden");
    page.set("visible");
    expect(wakeLock.requests).toBe(2);
    expect(store.sent.at(-1)).toEqual({ type: "micPage", visible: true });
    // Still lost: only the Sing again tap reopens the mic.
    expect(mic.getSnapshot().state).toBe("lost");
    page.set("hidden");
    page.set("visible");
    expect(wakeLock.requests).toBe(3);
  });

  it("Sing again reopens the mic with the same constraints and the Wake Lock, on a fresh frame mapping", async () => {
    const { mic, store, nodes, time, page, media, wakeLock } = await setUp();
    mic.turnOn();
    await settle();
    // The first context ran a while: frame 480000 (10 s) arrives at 11.2 s,
    // so its stored spreads say the frame clock started at 1.2 s.
    time.advanceTo(11200);
    nodes.emit(reading(480000));
    page.set("hidden");
    time.advanceTo(30000);
    page.set("visible");
    const requests = wakeLock.requests;

    mic.singAgain();
    expect(wakeLock.requests).toBe(requests + 1);
    expect(mic.getSnapshot().state).toBe("opening");
    await settle();
    expect(mic.getSnapshot().state).toBe("on");
    expect(media.constraints).toHaveLength(2);
    expect(media.constraints[1]).toEqual(media.constraints[0]);
    expect(nodes.made).toHaveLength(2);

    // The new context counts frames from 0 again. A reading at frame 48000
    // (1 s) arriving at 31.2 s maps to about 30.2 s + offset; with the old
    // spreads kept it would map to about 2.2 s + offset.
    time.advanceTo(30200);
    time.advanceTo(31200);
    nodes.emit(reading(48000));
    const last = sentReadings(store.sent).at(-1);
    if (!last) throw new Error("no reading after Sing again");
    // The Stage runs 1000 ms ahead; half a window is about 21 ms.
    expect(last.captureMs).toBeCloseTo(31200 + 1000 - 1024 / 48, 0);
    mic.turnOff();
  });

  it("offers Sing again only once lost", async () => {
    const { mic, media } = await setUp();
    mic.singAgain();
    expect(media.constraints).toHaveLength(0);
    expect(mic.getSnapshot().state).toBe("off");
  });

  it("releases a lost mic for good on turnOff", async () => {
    const { mic, page, store } = await setUp();
    mic.turnOn();
    await settle();
    page.set("hidden");
    mic.turnOff();
    expect(mic.getSnapshot().state).toBe("off");
    const before = store.sent.length;
    page.set("visible");
    expect(store.sent.length).toBe(before);
  });
});

const sentOf = (sent: ClientMessage[], type: ClientMessage["type"]) =>
  sent.filter((m) => m.type === type);

describe("the Phone's mic after a network drop", () => {
  it("restarts clock sync with fast pings and sends no reading until a new offset exists", async () => {
    const { mic, store, nodes, time } = await setUp();
    mic.turnOn();
    await settle();
    // Synced, and past the fast pings: one a second.
    time.advanceTo(9000);
    nodes.emit(reading(48000 * 8));
    expect(sentReadings(store.sent)).toHaveLength(1);

    store.drop();
    time.advanceTo(12_000);
    const before = store.sent.length;
    store.reconnect();
    // Readings made after the reconnect wait for the first new pong.
    nodes.emit(reading(48000 * 11));
    expect(store.sent.slice(before)).toEqual([]);
    time.advanceTo(12_000 + 200);
    const pings = sentOf(store.sent.slice(before), "clockPing");
    expect(pings).toHaveLength(1);
    nodes.emit(reading(48000 * 11 + 512));
    expect(sentReadings(store.sent)).toHaveLength(2);
    // 200 ms apart for 5 s.
    time.advanceTo(17_000);
    expect(sentOf(store.sent.slice(before), "clockPing")).toHaveLength(25);
    mic.turnOff();
  });

  it("does nothing on a reconnect while the mic is off", async () => {
    const { mic, store } = await setUp();
    store.drop();
    store.reconnect();
    expect(store.sent).toEqual([]);
    expect(mic.getSnapshot().state).toBe("off");
  });
});

describe("the Phone's blocked mic", () => {
  it("names a refused permission and reports the mic blocked to the Stage", async () => {
    const { mic, store } = await setUp(
      new DOMException("denied", "NotAllowedError"),
    );
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot()).toMatchObject({
      state: "failed",
      blocked: "permissionRefused",
    });
    expect(sentOf(store.sent, "reportMicBlocked")).toEqual([
      { type: "reportMicBlocked", blocked: true },
    ]);
  });

  it("names a missing navigator.mediaDevices (no HTTPS) apart from a refusal", async () => {
    const { mic } = await setUp(new MediaDevicesMissingError());
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot()).toMatchObject({
      state: "failed",
      blocked: "noHttps",
    });
  });

  it("names any other failure to open as the mic not opening", async () => {
    const { mic, store } = await setUp(
      new DOMException("none", "NotFoundError"),
    );
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot().blocked).toBe("notOpened");
    expect(sentOf(store.sent, "reportMicBlocked")).toHaveLength(1);
  });

  it("retries on the same open path and clears the block when it opens", async () => {
    let refuse = true;
    const asked: MediaStreamConstraints[] = [];
    const ok = fakeMedia();
    const { mic, store } = await setUp(undefined, (constraints) => {
      asked.push(constraints);
      return refuse
        ? Promise.reject(new DOMException("denied", "NotAllowedError"))
        : ok.getUserMedia(constraints);
    });
    mic.turnOn();
    await settle();
    expect(mic.getSnapshot().state).toBe("failed");
    refuse = false;
    mic.turnOn();
    expect(mic.getSnapshot()).toMatchObject({
      state: "opening",
      blocked: null,
    });
    await settle();
    expect(mic.getSnapshot()).toMatchObject({ state: "on", blocked: null });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(asked[0]);
    expect(sentOf(store.sent, "reportMicBlocked")).toEqual([
      { type: "reportMicBlocked", blocked: true },
      { type: "reportMicBlocked", blocked: false },
    ]);
    mic.turnOff();
  });

  it("does not report an opened mic it never reported blocked", async () => {
    const { mic, store } = await setUp();
    mic.turnOn();
    await settle();
    expect(sentOf(store.sent, "reportMicBlocked")).toEqual([]);
    mic.turnOff();
  });

  it("reports the block again after a reconnect, since the server keeps it in memory only", async () => {
    const { mic, store } = await setUp(
      new DOMException("denied", "NotAllowedError"),
    );
    mic.turnOn();
    await settle();
    store.drop();
    store.reconnect();
    expect(sentOf(store.sent, "reportMicBlocked")).toEqual([
      { type: "reportMicBlocked", blocked: true },
      { type: "reportMicBlocked", blocked: true },
    ]);
  });

  it("clears a block it reported when the mic is turned off", async () => {
    const { mic, store } = await setUp(
      new DOMException("denied", "NotAllowedError"),
    );
    mic.turnOn();
    await settle();
    mic.turnOff();
    expect(mic.getSnapshot()).toMatchObject({ state: "off", blocked: null });
    expect(sentOf(store.sent, "reportMicBlocked").at(-1)).toEqual({
      type: "reportMicBlocked",
      blocked: false,
    });
  });
});
