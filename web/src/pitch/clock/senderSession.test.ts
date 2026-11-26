// Runs every case in fixtures/capture-clock/ through the WASM build of the
// capture clock (`just wasm` builds web/wasm/), behind the typed wrapper. The
// native build runs the same files (crates/capture-clock/tests/fixtures.rs);
// fixtures/capture-clock/README.md defines the format.

import { beforeAll, describe, expect, it } from "vitest";
import { createCaptureClock, type CaptureClock } from "./senderSession";

/** `just wasm` builds it. */
const WASM_FILE = `${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../wasm/openstar_detector.wasm`;

/** Expected stamps and offsets are written to 6 decimals. */
const EXACT_MS = 1e-5;

type Step = [string, ...(number | null)[]];

interface CaseFile {
  description: string;
  session: "remote" | "local";
  trueTimeSpreadMaxMs?: number;
  steps: Step[];
}

const caseTexts = import.meta.glob<string>(
  "../../../../fixtures/capture-clock/*.json",
  { query: "?raw", import: "default", eager: true },
);

const cases = Object.entries(caseTexts)
  .map(([file, text]) => ({
    name: file.split("/").pop() ?? file,
    file: JSON.parse(text) as CaseFile,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

let clock: CaptureClock;

beforeAll(async () => {
  // Read from disk, as pitchProcessor.test.ts does.
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
  clock = createCaptureClock(await WebAssembly.compile(bytes.slice().buffer));
});

const num = (v: number | null | undefined): number => {
  if (typeof v !== "number") throw new Error(`not a number: ${String(v)}`);
  return v;
};

function expectNear(at: string, got: number | null, want: number | null) {
  if (want === null || got === null) {
    expect(got, at).toBe(want);
    return;
  }
  expect(
    Math.abs(got - want),
    `${at}: got ${String(got)}, want ${String(want)}`,
  ).toBeLessThanOrEqual(EXACT_MS);
}

function run(name: string, file: CaseFile) {
  const session = file.session === "remote" ? clock.remote() : clock.local();
  let sampleRate = Number.NaN;
  const errors: number[] = [];
  try {
    file.steps.forEach((step, i) => {
      const at = `${name} step ${String(i)} ${JSON.stringify(step)}`;
      const [op, a, b, c, d] = step;
      switch (op) {
        case "start":
          session.startCapture(num(a));
          sampleRate = num(b);
          break;
        case "stop":
          session.stopCapture();
          break;
        case "restartSync":
          session.restartSync(num(a));
          break;
        case "ping":
          expectNear(at, session.pollPing(num(a)), b ?? null);
          break;
        case "nextPing":
          expectNear(at, session.nextPingAtMs(), a ?? null);
          break;
        case "offset":
          expectNear(at, session.offsetMs(), a ?? null);
          break;
        case "pong":
          session.receivePong(
            { t0: num(a), ts: num(c), epoch: num(d) },
            num(b),
          );
          break;
        case "reading": {
          const got = session.stamp(num(a), sampleRate, num(b));
          expectNear(at, got, c ?? null);
          if (got !== null && typeof d === "number") errors.push(got - d);
          break;
        }
        default:
          throw new Error(`${at}: unknown step ${op}`);
      }
    });
  } finally {
    session.dispose();
  }
  return errors;
}

describe("capture clock cases (WASM)", () => {
  it("finds the case files", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const { name, file } of cases) {
    it(name, () => {
      const errors = run(name, file);
      if (file.trueTimeSpreadMaxMs !== undefined) {
        expect(
          errors.length,
          `${name}: no reading has a true time`,
        ).toBeGreaterThan(0);
        const spread = Math.max(...errors) - Math.min(...errors);
        expect(
          spread,
          `${name}: stamp − true capture time spread`,
        ).toBeLessThanOrEqual(file.trueTimeSpreadMaxMs);
      }
    });
  }
});

describe("sender session wrapper", () => {
  it("stamps a worklet reading as the wire's PitchReading", () => {
    const session = clock.local();
    session.startCapture(0);
    expect(
      session.stampReading(
        {
          type: "reading",
          pitch: 69.5,
          clarity: 0.9,
          loudness: -30,
          zero: false,
          endFrame: 4800,
          sampleRate: 48_000,
        },
        101,
      ),
    ).toEqual({
      captureMs: 101 - 1024 / 48,
      pitch: 69.5,
      clarity: 0.9,
      loudness: -30,
    });
    session.dispose();
  });

  it("drops a Phone's reading before its first pong", () => {
    const session = clock.remote();
    session.startCapture(0);
    expect(
      session.stampReading(
        {
          type: "reading",
          pitch: null,
          clarity: 0.1,
          loudness: -80,
          zero: false,
          endFrame: 4800,
          sampleRate: 48_000,
        },
        101,
      ),
    ).toBeNull();
    session.dispose();
  });

  it("keeps sessions apart and goes inert once disposed", () => {
    const a = clock.remote();
    const b = clock.remote();
    a.startCapture(0);
    a.receivePong({ t0: 0, ts: 1002, epoch: 1 }, 4);
    expect(a.offsetMs()).toBe(1000);
    expect(b.offsetMs()).toBeNull();
    a.dispose();
    a.dispose();
    expect(a.offsetMs()).toBeNull();
    expect(a.pollPing(10_000)).toBeNull();
    // The freed id goes to a new session, which the old handle must not touch.
    const c = clock.remote();
    a.receivePong({ t0: 0, ts: 1002, epoch: 1 }, 4);
    expect(c.offsetMs()).toBeNull();
    b.dispose();
    c.dispose();
  });
});
