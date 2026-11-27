import { describe, expect, it, vi } from "vitest";

import { createGainChain, type GainChain } from "../playback/gainChain";
import { asAudioContext, pathFrom } from "../playback/fakeAudioContext";
import {
  fakeToneContext,
  gainAt,
  type FakeGainNode,
  type FakeOscillator,
  type FakeToneContext,
} from "./fakeToneContext";
import { integratedLoudness } from "./integratedLoudness";
import { playToneRun, TONE_AMPLITUDE } from "./toneRun";

const RATE = 48_000;

function setUp(volume?: number): {
  context: FakeToneContext;
  chain: GainChain;
} {
  const context = fakeToneContext();
  context.state = "running";
  context.currentTime = 3;
  // The context has output up to 2.95 s, which reached the output at 10 000 ms.
  context.timestamp = { contextTime: 2.95, performanceTime: 10_000 };
  const chain = createGainChain(
    asAudioContext(context),
    volume === undefined ? {} : { volume },
  );
  return { context, chain };
}

function envelopeOf(osc: FakeOscillator): FakeGainNode {
  return osc.outputs[0] as FakeGainNode;
}

/** The tones as they enter the chain, rendered offline from the scheduled graph. */
function render(context: FakeToneContext): Float32Array {
  const end = Math.max(...context.oscillators.map((o) => o.stopTime ?? 0));
  const samples = new Float32Array(Math.ceil((end + 0.5) * RATE));
  for (const osc of context.oscillators) {
    const start = osc.startTime ?? 0;
    const stop = osc.stopTime ?? start;
    const { events } = envelopeOf(osc).gain;
    for (let i = Math.ceil(start * RATE); i < stop * RATE; i++) {
      const t = i / RATE;
      samples[i] =
        (samples[i] ?? 0) +
        gainAt(events, t) *
          Math.sin(2 * Math.PI * osc.frequency.value * (t - start));
    }
  }
  return samples;
}

describe("the Calibration tone run", () => {
  it("is 8 sine tones of 200 ms at 440 Hz, starting 600 ms apart", () => {
    const { context, chain } = setUp();
    void playToneRun(chain);

    expect(context.oscillators).toHaveLength(8);
    const starts = context.oscillators.map((o) => o.startTime ?? NaN);
    for (const [i, osc] of context.oscillators.entries()) {
      expect(osc.type).toBe("sine");
      expect(osc.frequency.value).toBe(440);
      expect((osc.stopTime ?? NaN) - (osc.startTime ?? NaN)).toBeCloseTo(
        0.2,
        9,
      );
      if (i > 0) {
        expect((starts[i] ?? NaN) - (starts[i - 1] ?? NaN)).toBeCloseTo(0.6, 9);
      }
    }
    // Scheduled ahead of the context's time, never in its past.
    expect(starts[0]).toBeGreaterThan(3);
  });

  it("enters the chain after the Song gain and passes through the OpenStar volume", () => {
    const { context, chain } = setUp(50);
    const songGain = context.nodes[0];
    void playToneRun(chain);

    for (const osc of context.oscillators) {
      const path = pathFrom(osc);
      expect(path[2]).toBe(chain.input);
      expect(path).not.toContain(songGain);
      expect(path.at(-1)).toBe(context.destination);
      // The OpenStar volume node: (50/100)².
      expect(path.at(-2)?.gain.value).toBeCloseTo(0.25, 9);
    }
  });

  it("gives each tone's reported output time, not one from currentTime", async () => {
    const { context, chain } = setUp();
    const run = playToneRun(chain);
    const starts = context.oscillators.map((o) => o.startTime ?? NaN);

    // The first four tones play while the mapping stays put…
    context.playUntil(starts[3] as number);
    context.playUntil((starts[3] as number) + 0.2);
    // …then the output clock drifts by 2 ms against the Stage's clock.
    context.timestamp = { contextTime: 5, performanceTime: 12_052 };
    context.playUntil(100);

    const { toneOutputTimesMs } = await run;
    expect(toneOutputTimesMs).toHaveLength(8);
    for (const [i, start] of starts.entries()) {
      const expected =
        i < 4 ? 10_000 + (start - 2.95) * 1000 : 12_052 + (start - 5) * 1000;
      expect(toneOutputTimesMs[i]).toBeCloseTo(expected, 6);
    }
    // Mapped from currentTime (3 s at 10 000 ms) instead, the first tone would
    // land 50 ms early: the output latency the browser reports.
    const fromCurrentTime = 10_000 + ((starts[0] as number) - 3) * 1000;
    expect((toneOutputTimesMs[0] as number) - fromCurrentTime).toBeCloseTo(
      50,
      6,
    );
  });

  it("fails when the context reports no output", async () => {
    const { context, chain } = setUp();
    context.timestamp = { contextTime: 0, performanceTime: 0 };
    const run = playToneRun(chain);
    context.playUntil(100);
    await expect(run).rejects.toThrow(/output/);
  });

  it("comes to −18 LUFS, EBU R128 integrated, rendered offline", () => {
    const { context, chain } = setUp();
    void playToneRun(chain);
    const lufs = integratedLoudness(render(context), RATE);
    expect(Math.abs(lufs - -18)).toBeLessThanOrEqual(0.5);
  });

  it("ramps each tone in and out, so it does not click", () => {
    const { context, chain } = setUp();
    void playToneRun(chain);
    for (const osc of context.oscillators) {
      const { events } = envelopeOf(osc).gain;
      const start = osc.startTime as number;
      const stop = osc.stopTime as number;
      expect(gainAt(events, start)).toBe(0);
      expect(gainAt(events, stop)).toBe(0);
      expect(gainAt(events, (start + stop) / 2)).toBeGreaterThan(0);
    }
  });

  it("reports the OpenStar volume in effect at its first tone", async () => {
    const { context, chain } = setUp(65);
    const run = playToneRun(chain);
    context.playUntil((context.oscillators[0]?.startTime ?? 0) + 0.3);
    chain.setVolume(30);
    context.playUntil(100);
    expect((await run).volume).toBe(65);
  });

  it("stops every tone when aborted", async () => {
    const { context, chain } = setUp();
    const abort = new AbortController();
    const run = playToneRun(chain, { signal: abort.signal });
    context.currentTime = 4;
    abort.abort();
    await expect(run).rejects.toThrow();
    for (const osc of context.oscillators) {
      expect(osc.stopTime).toBeLessThanOrEqual(4);
      expect(osc.outputs).toHaveLength(0);
    }
  });
});

describe("the tone run's constants", () => {
  it("come from the Mic settings module", async () => {
    vi.resetModules();
    vi.doMock("../mics/micSettings", async (importOriginal) => {
      const real = await importOriginal<typeof import("../mics/micSettings")>();
      return {
        ...real,
        CALIBRATION: {
          ...real.CALIBRATION,
          toneCount: 3,
          toneDurationMs: 150,
          toneFrequencyHz: 880,
          toneOnsetSpacingMs: 1000,
          toneLoudnessLufs: -24,
        },
      };
    });
    const { playToneRun: play } = await import("./toneRun");
    const { context, chain } = setUp();
    void play(chain);

    expect(context.oscillators).toHaveLength(3);
    const [a, b] = context.oscillators;
    expect(a?.frequency.value).toBe(880);
    expect((a?.stopTime ?? NaN) - (a?.startTime ?? NaN)).toBeCloseTo(0.15, 9);
    expect((b?.startTime ?? NaN) - (a?.startTime ?? NaN)).toBeCloseTo(1, 9);
    // The level follows the target: 6 dB under the real run's tone.
    expect(
      (envelopeOf(a as FakeOscillator).gain.events[1]?.value ?? NaN) /
        TONE_AMPLITUDE,
    ).toBeCloseTo(10 ** (-6 / 20), 9);
    vi.doUnmock("../mics/micSettings");
  });
});
