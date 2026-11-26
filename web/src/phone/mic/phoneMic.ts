// The Phone's mic (v1 spec #50, ticket #128): the capture pipeline in
// remote mode, wired to the live store. Readings leave as `pitchReading`
// one by one as soon as they are stamped, pings as `clockPing`, and the
// Stage's `clockPong`s come back through `store.onClockPong`. Nothing on
// this path ever brings Song time, Beats, lyrics or Notes to the Phone.
//
// It lives outside React, one per live store, so the mic stays open while
// the Remote's screens change. Its lifecycle (#166): the tap opens it and
// requests the screen Wake Lock, asked for again each time the page is
// visible again; a hidden page counts as a lost mic (capture stops, the
// Stage is told with `micPage`), and the Sing again tap reopens it on a new
// context, so the frame mapping starts afresh. `followLineUp` releases it
// when the Phone leaves the Line-up.
//
// Failures it recovers from by itself (#129): after the WebSocket comes back
// (the store reconnects and presents the Phone id again), clock sync starts
// afresh with fast pings and no reading leaves until a new offset exists; a
// pong of a new epoch (the Stage page reloaded) is the capture clock's own
// business. When the mic cannot open it names the reason for the card and
// reports the mic blocked, so the Stage's seat warns; the retry runs the same
// open path and clears the report when it opens.

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

/** `lost`: the page was hidden while the mic was open; Sing again reopens it. */
export type PhoneMicState = "off" | "opening" | "on" | "failed" | "lost";

/**
 * Why the mic could not open: permission refused, no `navigator.mediaDevices`
 * (the page is not on HTTPS), or anything else (no mic, the worklet failed).
 */
export type MicBlockedReason = "permissionRefused" | "noHttps" | "notOpened";

/** What `getUserMedia` stands for when `navigator.mediaDevices` is missing. */
export class MediaDevicesMissingError extends Error {
  constructor() {
    super("navigator.mediaDevices is missing");
    this.name = "MediaDevicesMissingError";
  }
}

/** The reason a failed open stands for. */
export function micBlockedReason(error: unknown): MicBlockedReason {
  if (error instanceof MediaDevicesMissingError) return "noHttps";
  // A DOMException need not be an `Error` in every realm.
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? error.name
      : "";
  // Safari reports a refusal outside a secure context as SecurityError.
  if (name === "NotAllowedError" || name === "SecurityError")
    return "permissionRefused";
  return "notOpened";
}

export interface PhoneMicSnapshot {
  state: PhoneMicState;
  /** Set exactly while `failed`. */
  blocked: MicBlockedReason | null;
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
  /** Releases the mic (and the Wake Lock) for good. */
  turnOff: () => void;
  /** The Sing again tap, once `lost`: reopens the mic on a new context. */
  singAgain: () => void;
  /**
   * Calls `listener` with the loudness (dBFS) of every reading the mic
   * makes, synced to the Stage's clock or not: the takeover's ring and level
   * meter. Many times a second, so listeners write the DOM, not React state.
   * Returns the unsubscribe.
   */
  onLevel: (listener: (loudnessDbfs: number) => void) => () => void;
}

/** The page's visibility (`document.visibilityState`). */
export interface PageVisibility {
  hidden: () => boolean;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onChange: (listener: () => void) => () => void;
}

/** A held screen Wake Lock (`WakeLockSentinel`). */
export interface WakeLockHold {
  release: () => Promise<void>;
}

export interface PhoneMicOptions {
  store: {
    send: (message: ClientMessage) => boolean;
    onClockPong: (listener: (pong: ClockPongFields) => void) => () => void;
    /**
     * Calls `listener` each time the WebSocket is open again after a drop
     * (`onReconnect` in `reconnect.ts`); returns the unsubscribe.
     */
    onReconnect?: (listener: () => void) => () => void;
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
  /** The page's visibility; without it the page counts as always visible. */
  page?: PageVisibility;
  /** Requests the screen Wake Lock (`navigator.wakeLock.request("screen")`). */
  wakeLock?: () => Promise<WakeLockHold>;
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
  const levelListeners = new Set<(loudnessDbfs: number) => void>();
  const rate = createRateCounter();
  let snapshot: PhoneMicSnapshot = {
    state: "off",
    blocked: null,
    readingsPerSecond: 0,
    detector: null,
  };
  let pipeline: CapturePipeline | null = null;
  let readout: unknown = null;
  /** Bumped on every turn on or off, so a late result is ignored. */
  let attempt = 0;
  let wakeLock: WakeLockHold | null = null;
  /** Bumped on every request and release, so a late grant is let go. */
  let wakeAttempt = 0;
  /** Whether the server was last told this Phone's mic is blocked. */
  let reportedBlocked = false;

  function update(next: Partial<PhoneMicSnapshot>) {
    const merged = { ...snapshot, ...next };
    if (
      merged.state === snapshot.state &&
      merged.blocked === snapshot.blocked &&
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

  function requestWakeLock() {
    if (!options.wakeLock) return;
    const mine = ++wakeAttempt;
    let request: Promise<WakeLockHold>;
    try {
      request = options.wakeLock();
    } catch {
      return;
    }
    // Refused: the mic keeps working, only the screen may go dark.
    request.then(
      (hold) => {
        if (mine !== wakeAttempt) {
          void hold.release().catch(() => undefined);
          return;
        }
        const old = wakeLock;
        wakeLock = hold;
        if (old) void old.release().catch(() => undefined);
      },
      () => undefined,
    );
  }

  function releaseWakeLock() {
    wakeAttempt++;
    const old = wakeLock;
    wakeLock = null;
    if (old) void old.release().catch(() => undefined);
  }

  /** Stops capture and the readout; the state is the caller's. */
  function stopPipeline() {
    attempt++;
    stopReadout();
    pipeline?.stop();
    pipeline = null;
  }

  function reportBlocked(blocked: boolean) {
    if (!blocked && !reportedBlocked) return;
    reportedBlocked = blocked;
    store.send({ type: "reportMicBlocked", blocked });
  }

  function open() {
    const mine = ++attempt;
    update({ state: "opening", blocked: null });
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
      onWorkletReading: (reading) => {
        for (const listener of [...levelListeners]) listener(reading.loudness);
      },
    }).then(
      (started) => {
        if (mine !== attempt) {
          started.stop();
          return;
        }
        pipeline = started;
        update({ state: "on" });
        reportBlocked(false);
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
      (error: unknown) => {
        if (mine !== attempt) return;
        update({ state: "failed", blocked: micBlockedReason(error) });
        reportBlocked(true);
      },
    );
    requestWakeLock();
  }

  store.onReconnect?.(() => {
    // The server forgets a block when it restarts: tell it again.
    if (snapshot.state === "failed") {
      reportedBlocked = true;
      store.send({ type: "reportMicBlocked", blocked: true });
    }
    pipeline?.restartSync();
  });

  options.page?.onChange(() => {
    const { state } = snapshot;
    if (options.page?.hidden()) {
      // Capture in the background is never relied on: the mic is lost.
      if (state !== "opening" && state !== "on") return;
      stopPipeline();
      update({ state: "lost", readingsPerSecond: 0 });
      store.send({ type: "micPage", visible: false });
      return;
    }
    if (state === "lost") store.send({ type: "micPage", visible: true });
    // The browser let the Wake Lock go while the page was hidden.
    if (state === "opening" || state === "on" || state === "lost")
      requestWakeLock();
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    turnOn() {
      if (snapshot.state !== "off" && snapshot.state !== "failed") return;
      open();
    },
    turnOff() {
      stopPipeline();
      releaseWakeLock();
      update({ state: "off", blocked: null, readingsPerSecond: 0 });
      reportBlocked(false);
    },
    singAgain() {
      if (snapshot.state !== "lost") return;
      open();
    },
    onLevel(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
  };
}
