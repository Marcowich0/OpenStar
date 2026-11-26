import { describe, expect, it } from "vitest";

import type { PitchReading } from "../../generated/PitchReading";
import type { ClockPongFields } from "../clock/senderSession";
import { MIC_CONSTRAINTS, startCapture } from "./capturePipeline";
import {
  fakeContext,
  fakeMedia,
  fakePitchNodes,
  fakeTime,
  pipelineOptions,
} from "./testCapture";

const RATE = 48000;
/** The Stage page's clock runs this far ahead of the Phone page's. */
const STAGE_AHEAD_MS = 123_456.25;
const STAGE_EPOCH = 1_760_000_000_000;
/** The context's frame 0, on the Phone page's clock. */
const CONTEXT_START_MS = 5000;
const HALF_WINDOW_MS = (1024 / RATE) * 1000;

/**
 * A fake WebSocket between the Phone and a Stage: pings travel `oneWayMs`
 * each way, and the Stage answers at once on its own clock. `stage` is the
 * Stage page (a reload gives it a new clock and epoch); while `up` is false
 * the socket is down and pings and readings are lost.
 */
function fakeSocket(time: ReturnType<typeof fakeTime>, oneWayMs = 4) {
  const sent: PitchReading[] = [];
  const pings: number[] = [];
  const stage = { aheadMs: STAGE_AHEAD_MS, epoch: STAGE_EPOCH };
  let listener: ((pong: ClockPongFields) => void) | null = null;
  const socket = {
    sent,
    pings,
    stage,
    up: true,
    onPong: (l: (pong: ClockPongFields) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    get listening() {
      return listener !== null;
    },
    /** Delivers a pong as if the Stage had sent it. */
    pong: (pong: ClockPongFields) => {
      listener?.(pong);
    },
    sendPing: (t0: number) => {
      if (!socket.up) return;
      pings.push(t0);
      const at = time.now();
      const ts = at + oneWayMs + stage.aheadMs;
      const { epoch } = stage;
      time.setTimer(() => {
        listener?.({ t0, ts, epoch });
      }, 2 * oneWayMs);
    },
    deliver: (reading: PitchReading) => {
      if (socket.up) sent.push(reading);
    },
  };
  return socket;
}

/** Frame of the k-th reading (a reading every 512 frames, after 2048). */
const endFrame = (k: number) => 2048 + 512 * k;
const frameTimeMs = (k: number) =>
  CONTEXT_START_MS + (endFrame(k) / RATE) * 1000;
/** Where reading k's window centre is on the Stage's clock. */
const trueCaptureMs = (k: number) =>
  frameTimeMs(k) - HALF_WINDOW_MS + STAGE_AHEAD_MS;

/**
 * Runs a pipeline through `count` readings, the k-th handled `delay(k)` ms
 * after its last frame (never before the one before it: worklet messages
 * arrive in order), and returns what left on the socket.
 */
async function run(delay: (k: number) => number, count = 300) {
  const time = fakeTime(1000);
  const nodes = fakePitchNodes();
  const socket = fakeSocket(time);
  const pipeline = await startCapture(
    await pipelineOptions({
      time,
      createPitchNode: nodes.create,
      sendPing: socket.sendPing,
      onPong: socket.onPong,
      deliver: socket.deliver,
    }),
  );
  // The first pongs come back long before the first reading.
  time.advanceTo(CONTEXT_START_MS);
  let handled = 0;
  for (let k = 0; k < count; k++) {
    handled = Math.max(handled, frameTimeMs(k) + delay(k));
    time.advanceTo(handled);
    nodes.emit({
      pitch: 69,
      clarity: 0.9,
      loudness: -20,
      endFrame: endFrame(k),
      sampleRate: RATE,
    });
  }
  pipeline.stop();
  return socket;
}

describe("the capture pipeline", () => {
  it("opens the mic with echo cancellation and noise suppression on, auto gain off, one channel", async () => {
    const time = fakeTime();
    const media = fakeMedia();
    const context = fakeContext();
    const nodes = fakePitchNodes();
    const pipeline = await startCapture(
      await pipelineOptions({
        time,
        getUserMedia: media.getUserMedia,
        createContext: () => context,
        createPitchNode: nodes.create,
      }),
    );
    expect(media.constraints).toEqual([MIC_CONSTRAINTS]);
    expect(MIC_CONSTRAINTS.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
    // The same call made and resumed the context and loaded the worklet.
    expect(context.resumed).toBe(1);
    expect(context.sources).toBe(1);
    expect(context.splitterOutputs).toEqual([1]);
    expect(nodes.made).toHaveLength(1);
    expect(nodes.made[0]?.context).toBe(context);
    pipeline.stop();
    expect(media.stopped).toBe(1);
    expect(context.closed).toBe(1);
    expect(nodes.live).toBe(false);
  });

  it("asks for the mic and the context before it waits on anything", async () => {
    const time = fakeTime();
    const media = fakeMedia();
    const context = fakeContext();
    const options = await pipelineOptions({
      time,
      getUserMedia: media.getUserMedia,
      createContext: () => context,
    });
    const started = startCapture(options);
    // Still inside the tap: no await has run yet.
    expect(media.constraints).toHaveLength(1);
    expect(context.resumed).toBe(1);
    (await started).stop();
  });

  it("starts clock sync with fast pings on the tap", async () => {
    const time = fakeTime(1000);
    const socket = fakeSocket(time);
    const pipeline = await startCapture(
      await pipelineOptions({
        time,
        sendPing: socket.sendPing,
        onPong: socket.onPong,
        deliver: socket.deliver,
      }),
    );
    time.advanceTo(1000 + 1000);
    // 200 ms apart for the first 5 s: about 5 in the first second.
    expect(socket.pings.length).toBeGreaterThanOrEqual(5);
    expect(socket.pings.length).toBeLessThanOrEqual(6);
    expect(pipeline.offsetMs()).toBeCloseTo(STAGE_AHEAD_MS, 6);
    pipeline.stop();
    expect(socket.listening).toBe(false);
    const pings = socket.pings.length;
    time.advanceTo(10_000);
    expect(socket.pings).toHaveLength(pings);
  });

  it("sends nothing until an offset exists, then each reading at once, voiced or not", async () => {
    const time = fakeTime(1000);
    const nodes = fakePitchNodes();
    const socket = fakeSocket(time);
    const pipeline = await startCapture(
      await pipelineOptions({
        time,
        createPitchNode: nodes.create,
        sendPing: socket.sendPing,
        onPong: socket.onPong,
        deliver: socket.deliver,
      }),
    );
    const reading = (k: number, pitch: number | null) => {
      nodes.emit({
        pitch,
        clarity: 0.5,
        loudness: -30,
        endFrame: endFrame(k),
        sampleRate: RATE,
      });
    };
    // Before the first pong is back: dropped.
    reading(0, 60);
    expect(socket.sent).toHaveLength(0);
    time.advanceTo(1100);
    reading(1, 60);
    expect(socket.sent).toHaveLength(1);
    reading(2, null);
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({
      pitch: null,
      clarity: 0.5,
      loudness: -30,
    });
    pipeline.stop();
  });

  it("stamps readings on the Stage's clock, unmoved by main-thread delay", async () => {
    const prompt = await run(() => 0);
    // Jitter up to 40 ms, a 270 ms stall, and every 7th reading on time.
    const delayed = await run((k) =>
      k % 7 === 0 ? 0 : k >= 100 && k < 110 ? 270 : ((k * 37) % 41) * 1,
    );
    expect(prompt.sent).toHaveLength(300);
    expect(delayed.sent).toHaveLength(300);
    for (let k = 0; k < 300; k++) {
      expect(prompt.sent[k]?.captureMs).toBeCloseTo(trueCaptureMs(k), 6);
      expect(delayed.sent[k]?.captureMs).toBeCloseTo(trueCaptureMs(k), 6);
    }
  });

  it("runs as a Local mic with offset 0, delivering locally and never pinging", async () => {
    const time = fakeTime(1000);
    const nodes = fakePitchNodes();
    const delivered: PitchReading[] = [];
    const pipeline = await startCapture(
      await pipelineOptions({
        mode: "local",
        time,
        createPitchNode: nodes.create,
        deliver: (r) => delivered.push(r),
      }),
    );
    expect(pipeline.offsetMs()).toBe(0);
    time.advanceTo(frameTimeMs(0));
    nodes.emit({
      pitch: 69,
      clarity: 1,
      loudness: -10,
      endFrame: endFrame(0),
      sampleRate: RATE,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.captureMs).toBeCloseTo(
      frameTimeMs(0) - HALF_WINDOW_MS,
      6,
    );
    expect(time.pending()).toBe(0);
    pipeline.stop();
  });

  it("releases the mic and the context when the worklet cannot load", async () => {
    const time = fakeTime();
    const media = fakeMedia();
    const context = fakeContext();
    const options = await pipelineOptions({
      time,
      getUserMedia: media.getUserMedia,
      createContext: () => context,
      createPitchNode: () => Promise.reject(new Error("no worklet")),
    });
    await expect(startCapture(options)).rejects.toThrow("no worklet");
    expect(media.stopped).toBe(1);
    expect(context.closed).toBe(1);
  });

  it("closes the context when the mic is refused", async () => {
    const time = fakeTime();
    const context = fakeContext();
    const options = await pipelineOptions({
      time,
      getUserMedia: fakeMedia(new DOMException("no", "NotAllowedError"))
        .getUserMedia,
      createContext: () => context,
    });
    await expect(startCapture(options)).rejects.toThrow("no");
    expect(context.closed).toBe(1);
  });

  describe("after a network drop or a Stage reload", () => {
    async function syncedPipeline() {
      const time = fakeTime(1000);
      const nodes = fakePitchNodes();
      const socket = fakeSocket(time);
      const pipeline = await startCapture(
        await pipelineOptions({
          time,
          createPitchNode: nodes.create,
          sendPing: socket.sendPing,
          onPong: socket.onPong,
          deliver: socket.deliver,
        }),
      );
      // Past the fast pings: one a second from here.
      time.advanceTo(8000);
      expect(pipeline.offsetMs()).toBeCloseTo(STAGE_AHEAD_MS, 6);
      let k = 0;
      const reading = () => {
        nodes.emit({
          pitch: 60,
          clarity: 0.9,
          loudness: -20,
          endFrame: endFrame(k++),
          sampleRate: RATE,
        });
      };
      return { time, socket, pipeline, reading };
    }

    /** The gaps between the pings sent in (from, to]. */
    function gaps(pings: number[], from: number, to: number) {
      const inside = pings.filter((t0) => t0 > from && t0 <= to);
      return inside.slice(1).map((t0, i) => t0 - (inside[i] ?? t0));
    }

    it("restarts sync with pings every 200 ms for 5 s after a reconnect, sending no reading until a new offset exists", async () => {
      const { time, socket, pipeline, reading } = await syncedPipeline();
      socket.up = false;
      time.advanceTo(12_000);
      socket.up = true;
      pipeline.restartSync();
      // No offset until the first pong after the reconnect.
      expect(pipeline.offsetMs()).toBeNull();
      reading();
      expect(socket.sent).toHaveLength(0);
      time.advanceTo(12_100);
      expect(pipeline.offsetMs()).toBeCloseTo(STAGE_AHEAD_MS, 6);
      reading();
      expect(socket.sent).toHaveLength(1);
      // Fast for 5 s, then slow again.
      time.advanceTo(20_000);
      const fast = gaps(socket.pings, 12_000, 17_000);
      expect(fast.length).toBeGreaterThanOrEqual(23);
      for (const gap of fast) expect(gap).toBeCloseTo(200, 6);
      for (const gap of gaps(socket.pings, 17_400, 20_000))
        expect(gap).toBeCloseTo(1000, 6);
      pipeline.stop();
    });

    it("discards every sample on a pong with a new epoch and pings fast again", async () => {
      const { time, socket, pipeline, reading } = await syncedPipeline();
      // The Stage page reloads: a new clock, far from the old one.
      const RELOADED_AHEAD_MS = 9_000.5;
      socket.stage.aheadMs = RELOADED_AHEAD_MS;
      socket.stage.epoch = STAGE_EPOCH + 600_000;
      // The next slow ping brings the first pong of the new epoch.
      time.advanceTo(9100);
      // Only the new epoch's sample counts: the old ones, though their
      // round trips were as short, are gone.
      expect(pipeline.offsetMs()).toBeCloseTo(RELOADED_AHEAD_MS, 6);
      reading();
      expect(socket.sent.at(-1)?.captureMs).toBeLessThan(
        time.now() + RELOADED_AHEAD_MS,
      );
      expect(socket.sent.at(-1)?.captureMs).toBeGreaterThan(
        time.now() + RELOADED_AHEAD_MS - 1000,
      );
      time.advanceTo(13_000);
      const fast = gaps(socket.pings, 9000, 13_000);
      expect(fast.length).toBeGreaterThanOrEqual(18);
      for (const gap of fast) expect(gap).toBeCloseTo(200, 6);
      pipeline.stop();
    });

    it("ignores a late pong of the old epoch after the new one began", async () => {
      const { time, socket, pipeline } = await syncedPipeline();
      const oldEpoch = socket.stage.epoch;
      const oldPing = socket.pings.at(-1) ?? 0;
      socket.stage.aheadMs = 5000;
      socket.stage.epoch = oldEpoch + 1;
      time.advanceTo(9100);
      expect(pipeline.offsetMs()).toBeCloseTo(5000, 6);
      // A pong for a ping sent before the reload arrives late, on the old clock.
      socket.pong({
        t0: oldPing,
        ts: oldPing + STAGE_AHEAD_MS,
        epoch: oldEpoch,
      });
      expect(pipeline.offsetMs()).toBeCloseTo(5000, 6);
      pipeline.stop();
    });
  });
});
