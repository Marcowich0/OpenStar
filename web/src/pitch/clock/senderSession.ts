// The capture clock on the main thread: puts every Pitch reading on the
// Stage's clock (v1 spec #50, "Timestamping" and "Clock sync with the
// Stage"). The logic is `crates/capture-clock`, run here through the
// `openstar_clock_*` exports of the `detector-wasm` module (the same file the
// pitch worklet loads), so the browser runs exactly what the Mic bridge
// links natively. This file only types it.
//
// Every time is in ms on this page's `performance.now()`; the session reads
// no clock itself, the caller passes the times in.

import type { PitchReading } from "../../generated/PitchReading";
import type { PitchWorkletReading } from "../worklet/pitchMessages";
import { detectorWasm } from "../worklet/pitchWorklet";

/** The clock exports of crates/detector-wasm/src/clock.rs. NaN is "none". */
interface ClockExports {
  openstar_clock_new: (local: number) => number;
  openstar_clock_free: (id: number) => void;
  openstar_clock_start_capture: (id: number, nowMs: number) => void;
  openstar_clock_stop_capture: (id: number) => void;
  openstar_clock_restart_sync: (id: number, nowMs: number) => void;
  openstar_clock_poll_ping: (id: number, nowMs: number) => number;
  openstar_clock_next_ping_at: (id: number) => number;
  openstar_clock_receive_pong: (
    id: number,
    t0: number,
    t1: number,
    ts: number,
    epoch: number,
  ) => void;
  openstar_clock_offset: (id: number) => number;
  openstar_clock_stamp: (
    id: number,
    endFrame: number,
    sampleRate: number,
    handledMs: number,
  ) => number;
}

/** The fields of a `clockPong` from the server (`ServerMessage`). */
export interface ClockPongFields {
  t0: number;
  ts: number;
  epoch: number;
}

/** One capturing Mic's way from a worklet reading to the Stage's clock. */
export interface SenderSession {
  /**
   * Capture started, or started again on a new `AudioContext` or stream
   * (Sing again): the frame mapping starts afresh and pings go fast. Call it
   * before the first reading of every new context.
   */
  startCapture: (nowMs: number) => void;
  /** Capture stopped: no more pings. */
  stopCapture: () => void;
  /**
   * The WebSocket connected again: every sample is discarded, readings are
   * dropped until the next pong, and pings go fast.
   */
  restartSync: (nowMs: number) => void;
  /** The `t0` to send as `ClockPing { t0 }` when a ping is due; else null. */
  pollPing: (nowMs: number) => number | null;
  /** When the next ping is due (for a timer); null while none will be. */
  nextPingAtMs: () => number | null;
  /** A `clockPong` arrived; `t1Ms` is when it was handled. */
  receivePong: (pong: ClockPongFields, t1Ms: number) => void;
  /** Stage clock − page clock; null before an offset exists (0 for a Local mic). */
  offsetMs: () => number | null;
  /**
   * The capture time (window centre) on the Stage's clock of a reading ending
   * at `endFrame`, handled at `handledMs`; null when it is dropped.
   */
  stamp: (
    endFrame: number,
    sampleRate: number,
    handledMs: number,
  ) => number | null;
  /** `stamp` for a worklet reading, as the wire's `PitchReading`; null when dropped. */
  stampReading: (
    reading: PitchWorkletReading,
    handledMs: number,
  ) => PitchReading | null;
  /** Frees the session. */
  dispose: () => void;
}

export interface CaptureClock {
  /** A Phone's (or any sender's that syncs by pings). */
  remote: () => SenderSession;
  /** The Stage browser's own Local mics: offset 0, no pings. */
  local: () => SenderSession;
}

const orNull = (value: number): number | null =>
  Number.isNaN(value) ? null : value;

/** Sessions on one instance of `module` (the `detector-wasm` module). */
export function createCaptureClock(module: WebAssembly.Module): CaptureClock {
  const clock = new WebAssembly.Instance(module, {})
    .exports as unknown as ClockExports;

  function session(local: boolean): SenderSession {
    const id = clock.openstar_clock_new(local ? 1 : 0);
    let disposed = false;
    const stamp = (endFrame: number, sampleRate: number, handledMs: number) =>
      disposed
        ? null
        : orNull(
            clock.openstar_clock_stamp(id, endFrame, sampleRate, handledMs),
          );
    return {
      startCapture: (nowMs) => {
        if (!disposed) clock.openstar_clock_start_capture(id, nowMs);
      },
      stopCapture: () => {
        if (!disposed) clock.openstar_clock_stop_capture(id);
      },
      restartSync: (nowMs) => {
        if (!disposed) clock.openstar_clock_restart_sync(id, nowMs);
      },
      pollPing: (nowMs) =>
        disposed ? null : orNull(clock.openstar_clock_poll_ping(id, nowMs)),
      nextPingAtMs: () =>
        disposed ? null : orNull(clock.openstar_clock_next_ping_at(id)),
      receivePong: ({ t0, ts, epoch }, t1Ms) => {
        if (!disposed)
          clock.openstar_clock_receive_pong(id, t0, t1Ms, ts, epoch);
      },
      offsetMs: () =>
        disposed ? null : orNull(clock.openstar_clock_offset(id)),
      stamp,
      stampReading: (reading, handledMs) => {
        const captureMs = stamp(
          reading.endFrame,
          reading.sampleRate,
          handledMs,
        );
        if (captureMs === null) return null;
        return {
          captureMs,
          pitch: reading.pitch,
          clarity: reading.clarity,
          loudness: reading.loudness,
        };
      },
      dispose: () => {
        // An id is given out again once freed, so free it once only.
        if (disposed) return;
        disposed = true;
        clock.openstar_clock_free(id);
      },
    };
  }

  return { remote: () => session(false), local: () => session(true) };
}

let loaded: Promise<CaptureClock> | null = null;

/** The page's capture clock, made once (again after a failure). */
export function loadCaptureClock(): Promise<CaptureClock> {
  loaded ??= detectorWasm()
    .then((bytes) => WebAssembly.compile(bytes))
    .then(createCaptureClock)
    .catch((error: unknown) => {
      loaded = null;
      throw error;
    });
  return loaded;
}
