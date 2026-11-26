// The Check A/V sync click (#163): once a second on the gain chain's
// AudioContext, into the chain's input after the Song gain (so through the
// OpenStar volume), each click's landing time its reported output time.

import { describe, expect, it } from "vitest";

import {
  fakeToneContext,
  type FakeToneContext,
} from "../calibration/fakeToneContext";
import { asAudioContext, pathFrom } from "../playback/fakeAudioContext";
import { volumeGain } from "../playback/gain";
import { createGainChain, type GainChain } from "../playback/gainChain";
import { startClickTrack, type ClickTimer } from "./clickTrack";

function setUp() {
  const context = fakeToneContext();
  context.state = "running";
  context.currentTime = 3;
  // The context has output up to 2.95 s, which reached the output at 10 000 ms.
  context.timestamp = { contextTime: 2.95, performanceTime: 10_000 };
  const chain = createGainChain(asAudioContext(context), { volume: 60 });
  let tick: (() => void) | null = null;
  const timer: ClickTimer = {
    every(_ms, callback) {
      tick = callback;
      return () => {
        tick = null;
      };
    },
  };
  return {
    context,
    chain,
    timer,
    tick: () => {
      tick?.();
    },
    ticking: () => tick !== null,
  };
}

function starts(context: FakeToneContext): number[] {
  return context.oscillators.map((osc) => osc.startTime ?? NaN);
}

function inputOf(chain: GainChain) {
  return chain.input as unknown as ReturnType<FakeToneContext["createGain"]>;
}

describe("the Check A/V sync click track", () => {
  it("schedules clicks one second apart on the chain's AudioContext", () => {
    const { context, chain, timer } = setUp();
    startClickTrack(chain, { timer });
    const times = starts(context);
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toBeGreaterThan(3);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeCloseTo(1, 9);
    }
  });

  it("enters the chain after the Song gain, so the OpenStar volume applies", () => {
    const { context, chain, timer } = setUp();
    startClickTrack(chain, { timer });
    const click = context.oscillators[0];
    if (!click) throw new Error("no click");
    const path = pathFrom(click);
    const input = inputOf(chain);
    const at = path.indexOf(input);
    expect(at).toBeGreaterThan(0);
    expect(path[at + 1]?.gain.value).toBeCloseTo(volumeGain(60), 9);
    expect(path.at(-1)).toBe(context.destination);
  });

  it("lands each click at its reported output time, through getOutputTimestamp()", () => {
    const { context, chain, timer } = setUp();
    const track = startClickTrack(chain, { timer });
    const expected = starts(context).map(
      (start) => 10_000 + (start - 2.95) * 1000,
    );
    expect(track.landings()).toHaveLength(expected.length);
    track.landings().forEach((landing, i) => {
      expect(landing).toBeCloseTo(expected[i] ?? NaN, 6);
    });
  });

  it("keeps scheduling as the context's time runs on", () => {
    const { context, chain, timer, tick } = setUp();
    const track = startClickTrack(chain, { timer });
    const before = context.oscillators.length;
    context.currentTime += 1;
    context.timestamp = { contextTime: 3.95, performanceTime: 11_000 };
    tick();
    expect(context.oscillators.length).toBeGreaterThan(before);
    const times = starts(context);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeCloseTo(1, 9);
    }
    expect(track.landings().at(-1)).toBeCloseTo(
      11_000 + ((times.at(-1) ?? 0) - 3.95) * 1000,
      6,
    );
  });

  it("schedules nothing while the context reports no output yet", () => {
    const { context, chain, timer, tick } = setUp();
    context.timestamp = { contextTime: 0, performanceTime: 0 };
    const track = startClickTrack(chain, { timer });
    expect(context.oscillators).toHaveLength(0);
    expect(track.landings()).toEqual([]);
    context.timestamp = { contextTime: 2.95, performanceTime: 10_000 };
    tick();
    expect(context.oscillators.length).toBeGreaterThan(0);
  });

  it("stops every click and its timer at once", () => {
    const { context, chain, timer, ticking } = setUp();
    const track = startClickTrack(chain, { timer });
    track.stop();
    expect(ticking()).toBe(false);
    for (const osc of context.oscillators) {
      expect(osc.stopTime).toBe(3);
      expect(osc.outputs).toEqual([]);
    }
  });
});
