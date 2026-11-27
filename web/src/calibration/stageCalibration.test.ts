// The Stage's part of a Calibration run (#170): once the server says the
// tones start, the Stage plays them, gathers each Mic's relayed Pitch
// readings, runs the analysis and reports only the successes.

import { describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";
import type { MicId } from "../generated/MicId";
import type { MicKey } from "../generated/MicKey";
import type { PitchReading } from "../generated/PitchReading";
import { runCalibrationTones, type CalibrationStore } from "./stageCalibration";
import type { ToneRun } from "./toneRun";

const TONES = [1000, 1600, 2200, 2800, 3400, 4000, 4600, 5200];

function phone(phoneId: string): MicKey {
  return { kind: "phone", phoneId };
}

/** A clean A4 reading `delayMs` after each tone. */
function heard(delayMs: number, tones = TONES): PitchReading[] {
  return tones.map((tone) => ({
    captureMs: tone + delayMs,
    pitch: 69,
    clarity: 0.95,
    loudness: -40,
  }));
}

function fakeStore() {
  const sent: ClientMessage[] = [];
  const listeners = new Set<(mic: MicId, reading: PitchReading) => void>();
  const store: CalibrationStore = {
    send: (message) => {
      sent.push(message);
      return true;
    },
    onPitchReading: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const relayFrom = (mic: MicId, readings: PitchReading[]) => {
    for (const reading of readings)
      for (const listener of [...listeners]) listener(mic, reading);
  };
  const relay = (phoneId: string, readings: PitchReading[]) => {
    relayFrom({ kind: "phone", phoneId }, readings);
  };
  return { store, sent, relay, relayFrom, listening: () => listeners.size };
}

/** The Stage browser's own Local mics, as `subscribeLocalMicReadings`. */
function fakeLocalMics() {
  const listeners = new Set<(localMicId: string, r: PitchReading) => void>();
  return {
    subscribe: (listener: (localMicId: string, r: PitchReading) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: (localMicId: string, readings: PitchReading[]) => {
      for (const reading of readings)
        for (const listener of [...listeners]) listener(localMicId, reading);
    },
    listening: () => listeners.size,
  };
}

const localMic = (localMicId: string): MicKey => ({
  kind: "localMic",
  localMicId,
});

/** Tones that "play" while `during` relays readings, then resolve. */
function tones(during: () => void): () => Promise<ToneRun> {
  return () => {
    during();
    return Promise.resolve({ toneOutputTimesMs: TONES, volume: 80 });
  };
}

const noWait = () => Promise.resolve();

describe("the Stage's Calibration tones", () => {
  it("reports each Mic that heard the tones, with its Mic delay and bleed level, and leaves out the rest", async () => {
    const { store, sent, relay, listening } = fakeStore();
    await runCalibrationTones({
      store,
      mics: [phone("bo"), phone("jonas")],
      playTones: tones(() => {
        relay("bo", heard(102));
        // Jonas heard only 4 tones; a Phone not in the run is ignored.
        relay("jonas", heard(90, TONES.slice(0, 4)));
        relay("stranger", heard(50));
      }),
      wait: noWait,
      signal: new AbortController().signal,
    });
    expect(sent).toEqual([
      {
        type: "finishCalibration",
        results: [
          {
            mic: phone("bo"),
            micDelayMs: 102,
            bleedLevelDbfs: -40,
            micThresholdDbfs: -34,
          },
        ],
      },
    ]);
    expect(listening()).toBe(0);
  });

  it("hears a bridge's Local mic relayed and the Stage browser's own, and sets each one's Mic threshold to its bleed level + 6 dB", async () => {
    const { store, sent, relayFrom } = fakeStore();
    const local = fakeLocalMics();
    await runCalibrationTones({
      store,
      localMicReadings: local.subscribe,
      mics: [localMic("bridge:b:card:0"), localMic("browser:s:red:0")],
      playTones: tones(() => {
        relayFrom(
          { kind: "bridge", bridgeId: "b", localMicId: "bridge:b:card:0" },
          heard(12),
        );
        local.read("browser:s:red:0", heard(30));
        // A Local mic not in the run is ignored.
        local.read("browser:s:blue:0", heard(5));
      }),
      wait: noWait,
      signal: new AbortController().signal,
    });
    expect(sent).toEqual([
      {
        type: "finishCalibration",
        results: [
          {
            mic: localMic("bridge:b:card:0"),
            micDelayMs: 12,
            bleedLevelDbfs: -40,
            micThresholdDbfs: -34,
          },
          {
            mic: localMic("browser:s:red:0"),
            micDelayMs: 30,
            bleedLevelDbfs: -40,
            micThresholdDbfs: -34,
          },
        ],
      },
    ]);
    expect(local.listening()).toBe(0);
  });

  it("keeps listening for late readings after the last tone", async () => {
    const { store, sent, relay } = fakeStore();
    const wait = vi.fn(() => {
      relay("bo", heard(110));
      return Promise.resolve();
    });
    await runCalibrationTones({
      store,
      mics: [phone("bo")],
      playTones: tones(() => {}),
      wait,
      signal: new AbortController().signal,
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      {
        type: "finishCalibration",
        results: [
          {
            mic: phone("bo"),
            micDelayMs: 110,
            bleedLevelDbfs: -40,
            micThresholdDbfs: -34,
          },
        ],
      },
    ]);
  });

  it("reports every Mic failed when the Stage could not play the tones", async () => {
    const { store, sent } = fakeStore();
    await runCalibrationTones({
      store,
      mics: [phone("bo")],
      playTones: () => Promise.reject(new Error("no output")),
      wait: noWait,
      signal: new AbortController().signal,
    });
    expect(sent).toEqual([{ type: "finishCalibration", results: [] }]);
  });

  it("reports nothing when the run ends before the analysis", async () => {
    const { store, sent, listening } = fakeStore();
    const aborted = new AbortController();
    await runCalibrationTones({
      store,
      mics: [phone("bo")],
      playTones: ({ signal }) => {
        aborted.abort();
        return Promise.reject(signal?.reason as Error);
      },
      wait: noWait,
      signal: aborted.signal,
    });
    expect(sent).toEqual([]);
    expect(listening()).toBe(0);
  });
});
