// The pitch-detection AudioWorklet: the one shared frontend entry every route
// loads (`pitchWorklet.ts` adds it to a context). Each node runs the
// `detector-wasm` module on its first input channel, 128 frames at a time,
// and posts every Pitch reading to the main thread as soon as it is made,
// voiced or not (v1 spec #50, ticket #105).
//
// This file runs in the `AudioWorkletGlobalScope`, built as a file of its own
// (`?worker&url`): it imports nothing at run time but what is bundled into it.

import {
  PITCH_PROCESSOR_NAME,
  type PitchProcessorOptions,
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
  readonly port: MessagePort;
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
  private readonly maker: WasmReadingMaker;

  constructor({
    processorOptions,
  }: {
    processorOptions: PitchProcessorOptions;
  }) {
    super();
    // A worklet may compile synchronously (the main thread may not, past
    // 4 KB); the module is small.
    const module = new WebAssembly.Module(processorOptions.wasm);
    this.maker = createWasmReadingMaker(module, sampleRate);
  }

  process(inputs: Float32Array[][]): boolean {
    // An input with nothing connected has no channels: it is silence, and
    // silent readings are posted too.
    const block = inputs[0]?.[0] ?? SILENCE;
    const blockStart = currentFrame;
    for (let at = 0; at < block.length; at += this.maker.capacity) {
      const end = Math.min(block.length, at + this.maker.capacity);
      const reading = this.maker.push(block.subarray(at, end));
      if (!reading) continue;
      const message: PitchWorkletReading = {
        type: "reading",
        pitch: reading.pitch,
        clarity: reading.clarity,
        loudness: reading.loudness,
        endFrame: blockStart + end,
        sampleRate,
      };
      this.port.postMessage(message);
    }
    return true;
  }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
