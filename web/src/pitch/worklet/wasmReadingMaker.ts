// The `detector-wasm` module (crates/detector-wasm) behind a small typed
// face. It calls the module's C ABI exports directly: no glue generator. One
// instance holds one reading maker, so each processor instantiates its own.

/** The exports of crates/detector-wasm/src/lib.rs. */
interface DetectorExports {
  memory: WebAssembly.Memory;
  openstar_detector_start: (sampleRate: number) => number;
  openstar_detector_block_capacity: () => number;
  openstar_detector_push: (len: number) => number;
  openstar_detector_pitch: () => number;
  openstar_detector_clarity: () => number;
  openstar_detector_loudness: () => number;
  openstar_detector_end_frame: () => number;
}

/** A reading as the module reports it; `endFrame` counts frames fed to it. */
export interface WasmReading {
  pitch: number | null;
  clarity: number;
  loudness: number;
  endFrame: number;
}

export interface WasmReadingMaker {
  /** The most samples one `push` takes. */
  readonly capacity: number;
  /** Feeds one block of at most `capacity` samples; the reading made at its end, if one was due. */
  push: (block: Float32Array) => WasmReading | null;
}

export function createWasmReadingMaker(
  module: WebAssembly.Module,
  sampleRate: number,
): WasmReadingMaker {
  const instance = new WebAssembly.Instance(module, {});
  const detector = instance.exports as unknown as DetectorExports;
  const input = detector.openstar_detector_start(sampleRate);
  const capacity = detector.openstar_detector_block_capacity();
  // The memory may grow (the detector allocates on its first window), which
  // detaches old views: make a new one whenever the buffer changed.
  let buffer: ArrayBuffer | null = null;
  let view = new Float32Array(0);

  return {
    capacity,
    push(block) {
      if (block.length > capacity)
        throw new Error(`a block holds at most ${String(capacity)} samples`);
      if (detector.memory.buffer !== buffer) {
        buffer = detector.memory.buffer;
        view = new Float32Array(buffer, input, capacity);
      }
      view.set(block);
      if (detector.openstar_detector_push(block.length) !== 1) return null;
      const pitch = detector.openstar_detector_pitch();
      return {
        pitch: Number.isNaN(pitch) ? null : pitch,
        clarity: detector.openstar_detector_clarity(),
        loudness: detector.openstar_detector_loudness(),
        endFrame: detector.openstar_detector_end_frame(),
      };
    },
  };
}
