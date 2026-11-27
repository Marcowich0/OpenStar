// Fakes for the capture pipeline's tests: a capture stream, an AudioContext,
// a pitch node the test drives by hand, a page clock, timers, and the real
// capture clock (the WASM build `just wasm` makes).

import type { PitchWorkletReading } from "../worklet/pitchMessages";
import { createCaptureClock, type CaptureClock } from "../clock/senderSession";
import type {
  CaptureAudioContext,
  CapturePipelineOptions,
  PitchNodeLike,
} from "./capturePipeline";

const WASM_FILE = `${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../wasm/openstar_detector.wasm`;

let module: Promise<WebAssembly.Module> | null = null;

/** The `detector-wasm` module, read from disk once. */
export function detectorModule(): Promise<WebAssembly.Module> {
  module ??= (async () => {
    const fs = "node:fs";
    const { readFileSync } = (await import(/* @vite-ignore */ fs)) as {
      readFileSync: (path: string) => Uint8Array<ArrayBuffer>;
    };
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = readFileSync(WASM_FILE);
    } catch {
      throw new Error(`${WASM_FILE} is missing: run \`just wasm\``);
    }
    return WebAssembly.compile(bytes.slice().buffer);
  })();
  return module;
}

export async function realCaptureClock(): Promise<CaptureClock> {
  return createCaptureClock(await detectorModule());
}

/** A page clock and timers the test moves by hand. */
export function fakeTime(start = 1000) {
  let now = start;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + Math.max(0, ms), run, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    /** Moves the clock to `to`, running every timer due on the way. */
    advanceTo(to: number) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > to) break;
        timers.shift();
        now = Math.max(now, due.at);
        due.run();
      }
      now = Math.max(now, to);
    },
    pending: () => timers.length,
  };
}

export interface FakeMedia {
  constraints: MediaStreamConstraints[];
  stopped: number;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
}

export function fakeMedia(refuse?: Error): FakeMedia {
  const media: FakeMedia = {
    constraints: [],
    stopped: 0,
    getUserMedia(constraints) {
      media.constraints.push(constraints);
      if (refuse) return Promise.reject(refuse);
      const track = {
        stop: () => {
          media.stopped += 1;
        },
      };
      return Promise.resolve({
        getTracks: () => [track],
      } as unknown as MediaStream);
    },
  };
  return media;
}

const fakeNode = () => ({
  connect: () => undefined,
  disconnect: () => undefined,
});

export interface FakeContext extends CaptureAudioContext {
  resumed: number;
  closed: number;
  splitterOutputs: number[];
  sources: number;
}

export function fakeContext(sampleRate = 48000): FakeContext {
  const context: FakeContext = {
    sampleRate,
    resumed: 0,
    closed: 0,
    splitterOutputs: [],
    sources: 0,
    resume() {
      context.resumed += 1;
      return Promise.resolve();
    },
    close() {
      context.closed += 1;
      return Promise.resolve();
    },
    createMediaStreamSource() {
      context.sources += 1;
      return fakeNode() as unknown as MediaStreamAudioSourceNode;
    },
    createChannelSplitter(outputs?: number) {
      context.splitterOutputs.push(outputs ?? 6);
      return fakeNode() as unknown as ChannelSplitterNode;
    },
  };
  return context;
}

/** A pitch node factory: `emit` posts a worklet reading as the node would. */
export function fakePitchNodes() {
  let onReading: ((reading: PitchWorkletReading) => void) | null = null;
  const made: { context: CaptureAudioContext; disconnected: boolean }[] = [];
  return {
    made,
    create: (
      context: CaptureAudioContext,
      listener: (reading: PitchWorkletReading) => void,
    ): Promise<PitchNodeLike> => {
      onReading = listener;
      const entry = { context, disconnected: false };
      made.push(entry);
      return Promise.resolve({
        disconnect: () => {
          entry.disconnected = true;
          onReading = null;
        },
        port: { close: () => undefined },
      });
    },
    emit(
      reading: Omit<PitchWorkletReading, "type" | "zero"> & { zero?: boolean },
    ) {
      onReading?.({ type: "reading", zero: false, ...reading });
    },
    get live() {
      return onReading !== null;
    },
  };
}

/** The options every pipeline test needs, with the fakes above. */
export async function pipelineOptions(
  overrides: Partial<CapturePipelineOptions> & {
    time: ReturnType<typeof fakeTime>;
  },
): Promise<CapturePipelineOptions> {
  const clock = await realCaptureClock();
  const { time, ...rest } = overrides;
  return {
    mode: "remote",
    getUserMedia: fakeMedia().getUserMedia,
    createContext: () => fakeContext(),
    createPitchNode: fakePitchNodes().create,
    captureClock: () => Promise.resolve(clock),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    deliver: () => undefined,
    ...rest,
  };
}
