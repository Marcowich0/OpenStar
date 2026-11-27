// A stand-in `AudioContext` for the UI sound engine's tests: the Calibration
// tone fake (graph, oscillators, gain automation) plus what synthesized
// sounds also use: pitch sweeps, noise buffers and filters. Nothing plays;
// a test reads which sources started and where they lead.

import {
  fakeToneContext,
  type FakeToneContext,
} from "../../calibration/fakeToneContext";
import { pathFrom, type FakeNode } from "../../playback/fakeAudioContext";

export interface FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null;
  startTime: number | null;
  stopTime: number | null;
  onended: (() => void) | null;
  start(when: number): void;
  stop(when: number): void;
}

export interface FakeSynthContext extends FakeToneContext {
  readonly sampleRate: number;
  /** Noise bursts started, in order. */
  readonly bufferSources: FakeBufferSource[];
  createBuffer(channels: number, length: number, rate: number): AudioBuffer;
  createBufferSource(): FakeBufferSource;
  createBiquadFilter(): FakeNode;
}

/** A param that takes the automation calls a sweep makes and keeps its value. */
function param(start: number) {
  const made = {
    value: start,
    setValueAtTime(value: number) {
      made.value = value;
    },
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  };
  return made;
}

function plainNode(kind: string): FakeNode {
  const made: FakeNode = {
    kind,
    gain: { value: 1 },
    outputs: [],
    connect(destination) {
      made.outputs.push(destination);
      return destination;
    },
    disconnect() {
      made.outputs = [];
    },
  };
  return made;
}

export function fakeSynthContext(): FakeSynthContext {
  const context = fakeToneContext() as FakeSynthContext;
  const bufferSources: FakeBufferSource[] = [];
  const baseOscillator = context.createOscillator.bind(context);
  Object.assign(context, {
    sampleRate: 48_000,
    bufferSources,
    createOscillator() {
      const osc = baseOscillator();
      Object.assign(osc, { frequency: param(osc.frequency.value) });
      return osc;
    },
    createBuffer(channels: number, length: number, rate: number) {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (channel: number) => data[channel],
      } as unknown as AudioBuffer;
    },
    createBufferSource() {
      const source = Object.assign(plainNode("noise"), {
        buffer: null,
        startTime: null,
        stopTime: null,
        onended: null,
        start(when: number) {
          source.startTime = when;
        },
        stop(when: number) {
          source.stopTime = when;
        },
      }) as FakeBufferSource;
      bufferSources.push(source);
      context.nodes.push(source);
      return source;
    },
    createBiquadFilter() {
      const filter = Object.assign(plainNode("filter"), {
        type: "lowpass",
        frequency: param(350),
        Q: param(1),
      });
      context.nodes.push(filter);
      return filter;
    },
  });
  return context;
}

/** Every source started (oscillators and noise bursts), in order. */
export function startedSources(context: FakeSynthContext): FakeNode[] {
  return [...context.oscillators, ...context.bufferSources].filter(
    (source) => source.startTime !== null,
  );
}

/** Whether `source`'s path reaches `target`. */
export function reaches(source: FakeNode, target: unknown): boolean {
  return pathFrom(source).includes(target as FakeNode);
}
