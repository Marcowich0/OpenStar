/**
 * Detector accuracy on real singing (ticket #91): the Vocadito excerpts in
 * `fixtures/vocadito/`, run through the pitch worklet's real processor with
 * the real `detector-wasm` module (`just wasm` builds it), in 128-frame blocks
 * as an `AudioWorkletGlobalScope` feeds it. Measured per excerpt and overall:
 * the share of voiced reference frames where the reading, folded to the
 * reference's octave, is within 50 cents. The floors in
 * `fixtures/vocadito/floors.json` only ever rise (`fixtures/README.md`).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PITCH_PROCESSOR_NAME,
  type PitchProcessorOptions,
  type PitchWorkletMessage,
  type PitchWorkletReading,
} from "../worklet/pitchMessages";
import {
  parseReferenceCsv,
  parseWav,
  rawPitchAccuracy,
  type Accuracy,
} from "./pitchAccuracy";

interface Floors {
  overallMinPct: number;
  excerptMinPct: Record<string, number>;
}

const FIXTURES = `${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../../fixtures/vocadito`;
/** `just wasm` builds it. */
const WASM_FILE = `${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../wasm/openstar_detector.wasm`;
/** A reading's window centre lies this many frames before its end frame. */
const HALF_WINDOW = 1024;

const referenceTexts = import.meta.glob<string>(
  "../../../../fixtures/vocadito/*_f0.csv",
  { query: "?raw", import: "default", eager: true },
);
const floorsText = Object.values(
  import.meta.glob<string>("../../../../fixtures/vocadito/floors.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];
const floors = JSON.parse(floorsText ?? "{}") as Floors;

const excerpts = Object.entries(referenceTexts)
  .map(([path, text]) => ({
    name: (path.split("/").pop() ?? path).replace(/_f0\.csv$/, ""),
    reference: parseReferenceCsv(text),
  }))
  .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

type ProcessorClass = new (options: {
  processorOptions: PitchProcessorOptions;
}) => { process: (inputs: Float32Array[][]) => boolean };

const scope = { sampleRate: 44_100, currentFrame: 0 };
let posted: PitchWorkletMessage[] = [];
let wasm: ArrayBuffer;
let Processor: ProcessorClass;
let readFile: (path: string) => Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  // src/ has no Node types, so the one call this needs is typed here.
  const fs = "node:fs";
  ({ readFileSync: readFile } = (await import(/* @vite-ignore */ fs)) as {
    readFileSync: (path: string) => Uint8Array<ArrayBuffer>;
  });
  try {
    wasm = readFile(WASM_FILE).slice().buffer;
  } catch {
    throw new Error(`${WASM_FILE} is missing: run \`just wasm\``);
  }

  const registered = new Map<string, ProcessorClass>();
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = {
        onmessage: null,
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
  await import("../worklet/pitchProcessor");
  const registeredProcessor = registered.get(PITCH_PROCESSOR_NAME);
  if (!registeredProcessor) throw new Error("the processor did not register");
  Processor = registeredProcessor;
});

/** The excerpt's readings, through a fresh processor, 128 frames per block. */
function detect(name: string): { timeS: number; pitch: number | null }[] {
  const { sampleRate, samples } = parseWav(readFile(`${FIXTURES}/${name}.wav`));
  scope.sampleRate = sampleRate;
  scope.currentFrame = 0;
  posted = [];
  const processor = new Processor({ processorOptions: { wasm } });
  for (let at = 0; at < samples.length; at += 128) {
    const block = samples.subarray(at, Math.min(samples.length, at + 128));
    processor.process([[block]]);
    scope.currentFrame += block.length;
  }
  return posted
    .filter((m): m is PitchWorkletReading => m.type === "reading")
    .map((r) => ({
      timeS: (r.endFrame - HALF_WINDOW) / r.sampleRate,
      pitch: r.pitch,
    }));
}

const pct = ({ hits, voicedFrames }: Accuracy) => (100 * hits) / voicedFrames;

describe("detector accuracy on the Vocadito excerpts", () => {
  const measured = new Map<string, Accuracy>();

  it("has about five excerpts, each with audio and a floor", () => {
    expect(excerpts.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(floors.excerptMinPct).sort()).toEqual(
      excerpts.map((e) => e.name).sort(),
    );
  });

  it.each(excerpts)(
    "$name stays at or above its floor",
    ({ name, reference }) => {
      const accuracy = rawPitchAccuracy(reference, detect(name));
      measured.set(name, accuracy);
      expect(accuracy.voicedFrames).toBeGreaterThan(0);
      expect(
        pct(accuracy),
        `${name}: % of ${String(accuracy.voicedFrames)} voiced frames`,
      ).toBeGreaterThanOrEqual(floors.excerptMinPct[name] ?? Infinity);
    },
  );

  it("stays at or above the overall floor", () => {
    const sum = (key: keyof Accuracy) =>
      excerpts.reduce((total, { name, reference }) => {
        const accuracy =
          measured.get(name) ?? rawPitchAccuracy(reference, detect(name));
        return total + accuracy[key];
      }, 0);
    const overall = { hits: sum("hits"), voicedFrames: sum("voicedFrames") };
    expect(pct(overall), "overall %").toBeGreaterThanOrEqual(
      floors.overallMinPct,
    );
  });
});
