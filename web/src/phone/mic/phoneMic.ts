// The Phone's mic (v1 spec #50, ticket #128): the capture pipeline in
// remote mode, wired to the live store. Readings leave as `pitchReading`
// one by one as soon as they are stamped, pings as `clockPing`, and the
// Stage's `clockPong`s come back through `store.onClockPong`. Nothing on
// this path ever brings Song time, Beats, lyrics or Notes to the Phone.
//
// It lives outside React, one per live store, so the mic stays open while
// the Remote's screens change. Opening it only on a tap, releasing it when
// the Phone leaves the Line-up and Sing again are #166's; the blocked-mic
// reasons and their report are #129's.

import type { ClientMessage } from "../../generated/ClientMessage";
import type { ClockPongFields } from "../../pitch/clock/senderSession";
import {
  startCapture,
  type CapturePipeline,
  type CapturePipelineOptions,
} from "../../pitch/capture/capturePipeline";
import {
  createRateCounter,
  type DetectorCost,
} from "../../pitch/capture/diagnostics";

export type PhoneMicState = "off" | "opening" | "on" | "failed";

export interface PhoneMicSnapshot {
  state: PhoneMicState;
  /** Readings that left in the last second. */
  readingsPerSecond: number;
  /** The detector's cost per window, once measured. */
  detector: DetectorCost | null;
}

export interface PhoneMic {
  getSnapshot: () => PhoneMicSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Call from the tap's handler itself: opens the mic and starts sync. */
  turnOn: () => void;
  /** Releases the mic. */
  turnOff: () => void;
}

export interface PhoneMicOptions {
  store: {
    send: (message: ClientMessage) => boolean;
    onClockPong: (listener: (pong: ClockPongFields) => void) => () => void;
  };
  /** The pipeline's devices and clocks; the Phone fills in the rest. */
  capture: Omit<
    CapturePipelineOptions,
    "mode" | "deliver" | "sendPing" | "onPong" | "onWorkletReading"
  >;
  /** Times the WASM detector on this thread (`measureDetectorCost`). */
  measureCost: () => Promise<DetectorCost>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** How often the readout's readings per second is refreshed. */
const READOUT_EVERY_MS = 500;

export function createPhoneMic(options: PhoneMicOptions): PhoneMic {
  const { store, capture } = options;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
  const listeners = new Set<() => void>();
  const rate = createRateCounter();
  let snapshot: PhoneMicSnapshot = {
    state: "off",
    readingsPerSecond: 0,
    detector: null,
  };
  let pipeline: CapturePipeline | null = null;
  let readout: unknown = null;
  /** Bumped on every turn on or off, so a late result is ignored. */
  let attempt = 0;

  function update(next: Partial<PhoneMicSnapshot>) {
    const merged = { ...snapshot, ...next };
    if (
      merged.state === snapshot.state &&
      merged.readingsPerSecond === snapshot.readingsPerSecond &&
      merged.detector === snapshot.detector
    )
      return;
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  }

  function refreshReadout() {
    readout = setTimer(() => {
      update({ readingsPerSecond: rate.perSecond(capture.now()) });
      refreshReadout();
    }, READOUT_EVERY_MS);
  }

  function stopReadout() {
    if (readout !== null) clearTimer(readout);
    readout = null;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    turnOn() {
      if (snapshot.state === "opening" || snapshot.state === "on") return;
      const mine = ++attempt;
      update({ state: "opening" });
      // Synchronous up to the first await: still inside the tap.
      startCapture({
        ...capture,
        mode: "remote",
        deliver: (reading) => {
          store.send({ type: "pitchReading", reading });
          rate.add(capture.now());
        },
        sendPing: (t0) => {
          store.send({ type: "clockPing", t0 });
        },
        onPong: store.onClockPong,
      }).then(
        (started) => {
          if (mine !== attempt) {
            started.stop();
            return;
          }
          pipeline = started;
          update({ state: "on" });
          refreshReadout();
          if (snapshot.detector === null) {
            options.measureCost().then(
              (detector) => {
                update({ detector });
              },
              () => undefined,
            );
          }
        },
        () => {
          if (mine === attempt) update({ state: "failed" });
        },
      );
    },
    turnOff() {
      attempt++;
      stopReadout();
      pipeline?.stop();
      pipeline = null;
      update({ state: "off", readingsPerSecond: 0 });
    },
  };
}
