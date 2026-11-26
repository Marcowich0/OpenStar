// The pitch-detection AudioWorklet: the one shared frontend entry every route
// loads (`pitchWorklet.ts` adds it to a context). Each node runs the
// `detector-wasm` module on its first input channel, 128 frames at a time,
// and posts every Pitch reading to the main thread as soon as it is made,
// voiced or not (v1 spec #50, ticket #105). Its detector can be switched off
// and on (`PitchNodeCommand`); while it is off the node posts only the
// window's loudness, for a meter (Stage-browser Local mics, ticket #130).
//
// This file runs in the `AudioWorkletGlobalScope`, built as a file of its own
// (`?worker&url`): it imports nothing at run time but what is bundled into it.

import { createLevelMeter, type LevelMeter } from "./levelMeter";
import {
  PITCH_PROCESSOR_NAME,
  type PitchNodeCommand,
  type PitchProcessorOptions,
  type PitchWorkletLevel,
  type PitchWorkletReading,
} from "./pitchMessages";
import {
  createWasmReadingMaker,
  type WasmReadingMaker,
} from "./wasmReadingMaker";

// The worklet scope's globals (TypeScript's DOM library has none of them).
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: Pick<MessagePort, "postMessage" | "onmessage">;
}
declare function registerProcessor(
  name: string,
  processor: new (options: {
    processorOptions: PitchProcessorOptions;
  }) => AudioWorkletProcessor,
): void;

/** A render quantum of silence, for an input with no channels. */
const SILENCE = new Float32Array(128);

class PitchProcessor extends AudioWorkletProcessor {
  private readonly module: WebAssembly.Module;
  /** The running detector; `null` while it is off. */
  private maker: WasmReadingMaker | null = null;
  private readonly meter: LevelMeter;

  constructor({
    processorOptions,
  }: {
    processorOptions: PitchProcessorOptions;
  }) {
    super();
    // A worklet may compile synchronously (the main thread may not, past
    // 4 KB); the module is small.
    this.module = new WebAssembly.Module(processorOptions.wasm);
    this.meter = createLevelMeter(sampleRate);
    this.detect(processorOptions.detect ?? true);
    this.port.onmessage = (event: MessageEvent<PitchNodeCommand>) => {
      this.detect(event.data.on);
    };
  }

  /** Switched on, a fresh detector starts with an empty window. */
  private detect(on: boolean) {
    if (!on) this.maker = null;
    else this.maker ??= createWasmReadingMaker(this.module, sampleRate);
  }

  process(inputs: Float32Array[][]): boolean {
    // An input with nothing connected has no channels: it is silence, and
    // silent readings are posted too.
    const block = inputs[0]?.[0] ?? SILENCE;
    const blockStart = currentFrame;
    // The meter always runs (it is cheap), so a detector switched off has a
    // full window of levels at once.
    const loudness = this.meter.push(block);
    const maker = this.maker;
    if (!maker) {
      if (loudness !== null) {
        const message: PitchWorkletLevel = {
          type: "level",
          loudness,
          zero: this.meter.zero(),
          endFrame: blockStart + block.length,
        };
        this.port.postMessage(message);
      }
      return true;
    }
    for (let at = 0; at < block.length; at += maker.capacity) {
      const end = Math.min(block.length, at + maker.capacity);
      const reading = maker.push(block.subarray(at, end));
      if (!reading) continue;
      const message: PitchWorkletReading = {
        type: "reading",
        pitch: reading.pitch,
        clarity: reading.clarity,
        loudness: reading.loudness,
        zero: this.meter.zero(),
        endFrame: blockStart + end,
        sampleRate,
      };
      this.port.postMessage(message);
    }
    return true;
  }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
