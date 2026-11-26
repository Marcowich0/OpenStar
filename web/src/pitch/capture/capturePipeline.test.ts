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
 * each way, and the Stage answers at once on its own clock.
 */
function fakeSocket(time: ReturnType<typeof fakeTime>, oneWayMs = 4) {
  const sent: PitchReading[] = [];
  const pings: number[] = [];
  let listener: ((pong: ClockPongFields) => void) | null = null;
  return {
    sent,
    pings,
    onPong: (l: (pong: ClockPongFields) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    get listening() {
      return listener !== null;
    },
    sendPing: (t0: number) => {
      pings.push(t0);
      const at = time.now();
      const ts = at + oneWayMs + STAGE_AHEAD_MS;
      time.setTimer(() => {
        listener?.({ t0, ts, epoch: STAGE_EPOCH });
      }, 2 * oneWayMs);
    },
    deliver: (reading: PitchReading) => {
      sent.push(reading);
    },
  };
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
});
