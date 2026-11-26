// The pitch-detection worklet's real processor (`pitchProcessor.ts`), run
// with the real `detector-wasm` module (`just wasm` builds it into web/wasm/)
// in a stand-in `AudioWorkletGlobalScope`: the same detector cases as the
// native build (`fixtures/detector/`), fed in 128-frame blocks, held to the
// same limits; and, for the same input, the same readings as the native build
// (`fixtures/detector/native/readings.json`).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  generate,
  percentile,
  pitchErrors,
  readingFailures,
  samplesDigest,
  type CaseFile,
} from "./detectorCases";
import nativeReadingsText from "../../../../fixtures/detector/native/readings.json?raw";
import {
  PITCH_PROCESSOR_NAME,
  type PitchProcessorOptions,
  type PitchWorkletMessage,
} from "./pitchMessages";

/** `just wasm` builds it. */
const WASM_FILE = `${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../wasm/openstar_detector.wasm`;

const caseTexts = import.meta.glob<string>(
  "../../../../fixtures/detector/*.json",
  { query: "?raw", import: "default", eager: true },
);

const cases = Object.entries(caseTexts)
  .map(([file, text]) => ({
    name: (file.split("/").pop() ?? file).replace(/\.json$/, ""),
    file: JSON.parse(text) as CaseFile,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

interface NativeRun {
  case: string;
  signal: number;
  sampleRate: number;
  samplesDigest: number;
  readings: [number | null, number, number, number][];
}

const nativeRuns = (JSON.parse(nativeReadingsText) as { runs: NativeRun[] })
  .runs;

type ProcessorClass = new (options: {
  processorOptions: PitchProcessorOptions;
}) => { process: (inputs: Float32Array[][]) => boolean };

let wasm: ArrayBuffer;
let Processor: ProcessorClass;

/** The stand-in for the worklet scope's globals while a processor runs. */
const scope = { sampleRate: 48_000, currentFrame: 0 };
let posted: PitchWorkletMessage[] = [];

beforeAll(async () => {
  // Read from disk: Vite has no `?inline` for WASM, and src/ has no Node
  // types, so the one call this needs is typed here.
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
  wasm = bytes.slice().buffer;

  const registered = new Map<string, ProcessorClass>();
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = {
        postMessage: (message: PitchWorkletMessage) => {
          posted.push(message);
        },
      };
    },
  );
  vi.stubGlobal("registerProcessor", (name: string, ctor: ProcessorClass) => {
    registered.set(name, ctor);
  });
  Object.defineProperty(globalThis, "sampleRate", {
    get: () => scope.sampleRate,
    configurable: true,
  });
  Object.defineProperty(globalThis, "currentFrame", {
    get: () => scope.currentFrame,
    configurable: true,
  });
  await import("./pitchProcessor");
  const registeredProcessor = registered.get(PITCH_PROCESSOR_NAME);
  if (!registeredProcessor) throw new Error("the processor did not register");
  Processor = registeredProcessor;
});

afterEach(() => {
  posted = [];
});

/** Runs `samples` through a fresh processor, `blockLen` frames per `process` call. */
function run(
  samples: Float32Array,
  sampleRate: number,
  { blockLen = 128, firstFrame = 0, input = true } = {},
): PitchWorkletMessage[] {
  scope.sampleRate = sampleRate;
  scope.currentFrame = firstFrame;
  posted = [];
  const processor = new Processor({ processorOptions: { wasm } });
  for (let at = 0; at < samples.length; at += blockLen) {
    const block = samples.subarray(at, Math.min(samples.length, at + blockLen));
    expect(processor.process(input ? [[block]] : [[]])).toBe(true);
    scope.currentFrame += block.length;
  }
  return posted;
}

describe("the pitch worklet", () => {
  it("posts every reading as it is made, silent ones too, with endFrame and the sample rate", () => {
    const messages = run(new Float32Array(4096), 48_000);
    // The first reading once the window has filled, then one every 512
    // frames (10 ms at 48 kHz, checked at the end of each 128-frame block).
    expect(messages.map((m) => m.endFrame)).toEqual([
      2048, 2560, 3072, 3584, 4096,
    ]);
    expect(messages[0]).toEqual({
      type: "reading",
      pitch: null,
      clarity: expect.any(Number) as number,
      loudness: -120,
      endFrame: 2048,
      sampleRate: 48_000,
    });
  });

  it("posts a reading in the very process call that made it", () => {
    scope.sampleRate = 44_100;
    scope.currentFrame = 0;
    posted = [];
    const processor = new Processor({ processorOptions: { wasm } });
    const counts: number[] = [];
    for (let block = 0; block < 20; block++) {
      processor.process([[new Float32Array(128)]]);
      scope.currentFrame += 128;
      counts.push(posted.length);
    }
    // Block 16 fills the window (16 × 128 = 2048); 441 more frames are due
    // after it, so block 20 is the next.
    expect(counts.indexOf(1)).toBe(15);
    expect(counts.at(-1)).toBe(2);
  });

  it("stamps endFrame on the audio frame clock: currentFrame plus the block", () => {
    const messages = run(new Float32Array(2048), 48_000, {
      firstFrame: 1_000_000,
    });
    expect(messages.map((m) => m.endFrame)).toEqual([1_002_048]);
  });

  it("reads an input with no channels as silence", () => {
    const messages = run(new Float32Array(2560), 48_000, { input: false });
    expect(messages.map((m) => [m.endFrame, m.pitch, m.loudness])).toEqual([
      [2048, null, -120],
      [2560, null, -120],
    ]);
  });

  it("finds every case file", () => {
    expect(cases.map((c) => c.name)).toEqual([
      "noise",
      "onset",
      "sawtooth",
      "sawtooth-vibrato",
      "silence",
      "sine",
      "sine-vibrato",
    ]);
  });
});

describe.each(cases)("detector case $name", ({ name, file }) => {
  it.each(file.sampleRates)("meets its limits at %d Hz", (sampleRate) => {
    expect(file.blockLen).toBe(128);
    const errors: number[] = [];
    for (const signal of file.signals) {
      const generated = generate(file, signal, sampleRate);
      const readings = run(generated.samples, sampleRate, {
        blockLen: file.blockLen,
      });
      expect(
        readingFailures(file, signal, generated, readings),
        `${name} @ ${String(sampleRate)} Hz, ${JSON.stringify(signal)}`,
      ).toEqual([]);
      expect(readings.every((r) => r.sampleRate === sampleRate)).toBe(true);
      if (signal.midi !== undefined)
        errors.push(
          ...pitchErrors(file, signal, generated, readings, sampleRate),
        );
    }
    const { medianCentsMax, p99CentsMax } = file.limits;
    if (medianCentsMax !== undefined && p99CentsMax !== undefined) {
      expect(errors.length).toBeGreaterThan(0);
      errors.sort((a, b) => a - b);
      expect(percentile(errors, 50)).toBeLessThan(medianCentsMax);
      expect(percentile(errors, 99)).toBeLessThanOrEqual(p99CentsMax);
    }
  });
});

describe("the WASM build against the native build", () => {
  // The two builds run the same Rust, but the WASM build's `sin`, `cos`,
  // `log2` and `log10` come from Rust's own maths library, not the system's,
  // and can differ in the last bit: about 1e-14 at most. Anything beyond this
  // tolerance is a real difference.
  const TOLERANCE = 1e-9;

  it("has native readings for every case file at every rate", () => {
    expect(nativeRuns.map((r) => `${r.case}@${String(r.sampleRate)}`)).toEqual(
      cases.flatMap((c) =>
        c.file.sampleRates.map((rate) => `${c.name}@${String(rate)}`),
      ),
    );
  });

  it.each(nativeRuns)(
    "makes the native readings of $case at $sampleRate Hz",
    (native) => {
      const found = cases.find((c) => c.name === native.case);
      if (!found) throw new Error(`no case file ${native.case}`);
      const signal = found.file.signals[native.signal];
      if (!signal) throw new Error(`no signal ${String(native.signal)}`);
      const generated = generate(found.file, signal, native.sampleRate);
      // The very same input: this generator made the native run's samples.
      expect(samplesDigest(generated.samples)).toBe(native.samplesDigest);

      const readings = run(generated.samples, native.sampleRate, {
        blockLen: found.file.blockLen,
      });
      expect(readings).toHaveLength(native.readings.length);
      readings.forEach((r, i) => {
        const [pitch, clarity, loudness, endFrame] = native.readings[i] ?? [];
        const at = `reading ${String(i)}`;
        expect(r.endFrame, at).toBe(endFrame);
        if (pitch === null || pitch === undefined)
          expect(r.pitch, at).toBeNull();
        else
          expect(Math.abs((r.pitch ?? NaN) - pitch), at).toBeLessThan(
            TOLERANCE,
          );
        expect(Math.abs(r.clarity - (clarity ?? NaN)), at).toBeLessThan(
          TOLERANCE,
        );
        expect(Math.abs(r.loudness - (loudness ?? NaN)), at).toBeLessThan(
          TOLERANCE,
        );
      });
    },
  );
});
