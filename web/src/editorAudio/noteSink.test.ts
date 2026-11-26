import { describe, expect, it } from "vitest";

import { createNoteSink, type SinkAudio } from "./noteSink";

interface Made {
  type: string;
  frequency: number;
  starts: number[];
  stops: (number | undefined)[];
  outputs: unknown[];
  gains: [string, number, number][];
}

/** An `AudioContext` that records each sound's oscillator and envelope. */
function fakeAudio() {
  const input = { name: "chain input" };
  const made: Made[] = [];
  const current = () => made[made.length - 1] as Made;
  const audio = {
    context: {
      createOscillator() {
        const record: Made = {
          type: "",
          frequency: 0,
          starts: [],
          stops: [],
          outputs: [],
          gains: [],
        };
        made.push(record);
        return {
          set type(v: string) {
            record.type = v;
          },
          frequency: {
            set value(v: number) {
              record.frequency = v;
            },
          },
          connect: (to: unknown) => to,
          disconnect() {},
          start(t: number) {
            record.starts.push(t);
          },
          stop(t?: number) {
            record.stops.push(t);
          },
          onended: null,
        };
      },
      createGain() {
        const record = current();
        return {
          gain: {
            setValueAtTime(v: number, t: number) {
              record.gains.push(["set", v, t]);
            },
            linearRampToValueAtTime(v: number, t: number) {
              record.gains.push(["ramp", v, t]);
            },
          },
          connect(to: unknown) {
            record.outputs.push(to);
            return to;
          },
          disconnect() {},
        };
      },
    },
    input,
  } as unknown as SinkAudio;
  return { audio, made, input };
}

describe("playing a Note sound into the chain", () => {
  it("plays a click into the chain's input, short, at its start", () => {
    const { audio, made, input } = fakeAudio();
    createNoteSink(audio).play({ kind: "click", at: 1, end: 1 }, 5, 5);
    expect(made).toHaveLength(1);
    expect(made[0]?.starts).toEqual([5]);
    expect(made[0]?.stops[0]).toBeGreaterThan(5);
    expect(made[0]?.stops[0]).toBeLessThan(5.1);
    expect(made[0]?.outputs).toEqual([input]);
  });

  it("makes the accent louder than a click", () => {
    const { audio, made } = fakeAudio();
    const sink = createNoteSink(audio);
    sink.play({ kind: "click", at: 1, end: 1 }, 5, 5);
    sink.play({ kind: "accent", at: 2, end: 2 }, 6, 6);
    const peak = (m: Made | undefined) =>
      Math.max(...(m?.gains ?? []).map((g) => g[1]));
    expect(peak(made[1])).toBeGreaterThan(peak(made[0]));
  });

  it("hums at the Note's pitch for its length", () => {
    const { audio, made } = fakeAudio();
    createNoteSink(audio).play({ kind: "hum", at: 1, end: 2, hz: 440 }, 5, 7);
    expect(made[0]?.type).toBe("sine");
    expect(made[0]?.frequency).toBe(440);
    expect(made[0]?.starts).toEqual([5]);
    expect(made[0]?.stops).toEqual([7]);
  });

  it("silences a sound at once when it is cancelled", () => {
    const { audio, made } = fakeAudio();
    const cancel = createNoteSink(audio).play(
      { kind: "hum", at: 1, end: 2, hz: 440 },
      5,
      7,
    );
    cancel();
    expect(made[0]?.stops).toEqual([7, undefined]);
  });
});
