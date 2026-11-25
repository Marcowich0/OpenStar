// A stand-in `AudioContext` for the Calibration tone run's tests: the
// playback fake (which records the graph) plus oscillators and gain
// automation, recorded so a test can render the run offline.

import {
  fakeAudioContext,
  type FakeAudioContext,
  type FakeNode,
} from "../playback/fakeAudioContext";

export type GainEvent =
  | { kind: "set"; value: number; time: number }
  | { kind: "linearRamp"; value: number; time: number };

export interface FakeGainNode extends FakeNode {
  readonly gain: {
    value: number;
    readonly events: GainEvent[];
    setValueAtTime(value: number, time: number): void;
    linearRampToValueAtTime(value: number, time: number): void;
  };
}

export interface FakeOscillator extends FakeNode {
  type: OscillatorType;
  readonly frequency: { value: number };
  startTime: number | null;
  stopTime: number | null;
  onended: (() => void) | null;
  start(when: number): void;
  stop(when: number): void;
}

export interface FakeToneContext extends FakeAudioContext {
  readonly oscillators: FakeOscillator[];
  createGain(): FakeGainNode;
  createOscillator(): FakeOscillator;
  /** Fires `onended` of every oscillator whose stop time is at or before `time`, in order (the test moves the context's time itself). */
  playUntil(time: number): void;
}

export function fakeToneContext(): FakeToneContext {
  const base = fakeAudioContext();
  const oscillators: FakeOscillator[] = [];
  const ended = new Set<FakeOscillator>();
  const baseCreateGain = base.createGain.bind(base);

  const context = base as FakeToneContext;
  Object.assign(context, {
    oscillators,
    createGain(): FakeGainNode {
      const made = baseCreateGain() as FakeNode & { gain: { value: number } };
      const events: GainEvent[] = [];
      Object.assign(made.gain, {
        events,
        setValueAtTime(value: number, time: number) {
          events.push({ kind: "set", value, time });
        },
        linearRampToValueAtTime(value: number, time: number) {
          events.push({ kind: "linearRamp", value, time });
        },
      });
      return made as FakeGainNode;
    },
    createOscillator(): FakeOscillator {
      const osc: FakeOscillator = {
        kind: "oscillator",
        gain: { value: 1 },
        outputs: [],
        type: "sine",
        frequency: { value: 440 },
        startTime: null,
        stopTime: null,
        onended: null,
        connect(destination) {
          osc.outputs.push(destination);
          return destination;
        },
        disconnect() {
          osc.outputs = [];
        },
        start(when: number) {
          osc.startTime = when;
        },
        stop(when: number) {
          osc.stopTime = when;
        },
      };
      oscillators.push(osc);
      base.nodes.push(osc);
      return osc;
    },
    playUntil(time: number) {
      for (const osc of oscillators) {
        if (ended.has(osc) || osc.stopTime === null || osc.stopTime > time) {
          continue;
        }
        ended.add(osc);
        osc.onended?.();
      }
    },
  });
  return context;
}

/** A gain's value at `time` from its recorded automation (Web Audio's rules for set and linear ramps). */
export function gainAt(events: readonly GainEvent[], time: number): number {
  let value = 0;
  let from = { value: 0, time: 0 };
  for (const event of events) {
    if (event.time > time) {
      if (event.kind === "linearRamp") {
        const share = (time - from.time) / (event.time - from.time);
        return from.value + (event.value - from.value) * share;
      }
      return value;
    }
    value = event.value;
    from = { value: event.value, time: event.time };
  }
  return value;
}
