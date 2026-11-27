// The one capture pipeline (v1 spec #50, ticket #128): from a mic to Pitch
// readings on the Stage's clock. A Phone runs it in "remote" mode (clock
// sync by pings over its WebSocket, readings sent at once); the Stage
// browser runs it for its own Local mics in "local" mode (offset 0, no
// pings, readings delivered on the page).
//
// Start it from the tap itself: browsers open a mic and start audio only
// inside a user gesture, so the mic and the context are asked for before
// anything is awaited.

import type { PitchReading } from "../../generated/PitchReading";
import type {
  CaptureClock,
  ClockPongFields,
  SenderSession,
} from "../clock/senderSession";
import type { PitchWorkletReading } from "../worklet/pitchMessages";
import { micConstraints } from "./micDiagnostics";

/**
 * The spec's constraints for a Phone mic: the browser's echo cancellation
 * and noise suppression on, auto gain off, one channel.
 */
export const MIC_CONSTRAINTS = micConstraints("standard");

/** What the pipeline uses of an `AudioContext`. */
export type CaptureAudioContext = Pick<
  AudioContext,
  | "sampleRate"
  | "resume"
  | "close"
  | "createMediaStreamSource"
  | "createChannelSplitter"
> &
  Partial<Pick<AudioContext, "baseLatency" | "outputLatency">>;

/** How one reading went from the worklet to the main thread (diagnostics). */
export interface WorkletReadingTiming {
  /** When the main thread handled it, ms on the page's clock. */
  handledMs: number;
  /**
   * How much longer than the quickest of the last second it waited between
   * its last audio frame and the main thread, ms; null until it is stamped.
   */
  workletWaitMs: number | null;
}

/** What the open capture is, for the diagnostics. */
export interface CaptureInfo {
  sampleRate: number;
  /** The context's `baseLatency` and `outputLatency`, ms (null: not told). */
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  /** The constraints the mic was asked for. */
  requested: MediaStreamConstraints;
  /** What the browser applied: the track's `getSettings()`. */
  settings: MediaTrackSettings | null;
  /** The track's label, `muted` and `readyState`. */
  label: string | null;
  muted: boolean | null;
  readyState: MediaStreamTrackState | null;
}

/** What the pipeline uses of a pitch node (`createPitchNode`). */
export interface PitchNodeLike {
  disconnect: () => void;
  port: { close: () => void };
}

export interface CapturePipelineOptions {
  /** "remote": a Phone (syncs by pings); "local": a Stage Local mic. */
  mode: "remote" | "local";
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createContext: () => CaptureAudioContext;
  /** `createPitchNode` from `../worklet/pitchWorklet`. */
  createPitchNode: (
    context: CaptureAudioContext,
    onReading: (reading: PitchWorkletReading) => void,
  ) => Promise<PitchNodeLike>;
  /** `loadCaptureClock` from `../clock/senderSession`. */
  captureClock: () => Promise<CaptureClock>;
  /** This page's clock, ms (`performance.now()`). */
  now: () => number;
  /** Takes every reading that has a capture time, as soon as it is made. */
  deliver: (reading: PitchReading) => void;
  /** Sends `clockPing { t0 }` (remote mode). */
  sendPing?: (t0: number) => void;
  /**
   * Subscribes to the `clockPong`s for this sender (remote mode); returns
   * the unsubscribe. Subscribed from the first ping until `stop()`.
   */
  onPong?: (listener: (pong: ClockPongFields) => void) => () => void;
  /** Told of every reading the worklet makes, stamped or not (diagnostics). */
  onWorkletReading?: (
    reading: PitchWorkletReading,
    timing: WorkletReadingTiming,
  ) => void;
  /** The mic's constraints; `MIC_CONSTRAINTS` when left out. */
  constraints?: MediaStreamConstraints;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface CapturePipeline {
  /** The WebSocket connected again: sync starts afresh (#129). */
  restartSync: () => void;
  /** Stage clock − page clock; null before an offset exists (0 when local). */
  offsetMs: () => number | null;
  /** The context, the constraints and the track, read now. */
  info: () => CaptureInfo;
  /** Releases the mic, the context and the clock session. */
  stop: () => void;
}

/** Half the detector window (2048 frames): a reading's stamp is its centre. */
const HALF_WINDOW_FRAMES = 1024;

const defaultSetTimer = (run: () => void, ms: number): unknown =>
  setTimeout(run, ms);
const defaultClearTimer = (timer: unknown) => {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
};

/**
 * Opens the mic and starts capture. Call it inside the tap's handler: the
 * mic and the context are asked for before the first await.
 */
export async function startCapture(
  options: CapturePipelineOptions,
): Promise<CapturePipeline> {
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  // Both inside the gesture.
  const context = options.createContext();
  const resumed = context.resume();
  const requested = options.constraints ?? MIC_CONSTRAINTS;
  const opened = options.getUserMedia(requested);

  let stream: MediaStream | null = null;
  let session: SenderSession | null = null;
  let node: PitchNodeLike | null = null;
  let timer: unknown = null;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  function release() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
    if (node) {
      node.disconnect();
      node.port.close();
    }
    node = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    session?.stopCapture();
    session?.dispose();
    session = null;
    void context.close().catch(() => undefined);
  }

  function schedulePing() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const at = session?.nextPingAtMs() ?? null;
    if (stopped || at === null || !options.sendPing) return;
    timer = setTimer(
      () => {
        timer = null;
        const t0 = session?.pollPing(options.now()) ?? null;
        if (t0 !== null) options.sendPing?.(t0);
        schedulePing();
      },
      Math.max(0, at - options.now()),
    );
  }

  try {
    const [clock, media] = await Promise.all([
      options.captureClock(),
      opened,
      resumed,
    ]).then(([c, m]) => [c, m] as const);
    stream = media;
    const live = options.mode === "local" ? clock.local() : clock.remote();
    session = live;
    // Before the first reading of this context; pings go fast from here.
    live.startCapture(options.now());
    unsubscribe =
      options.onPong?.((pong) => {
        if (session === live) live.receivePong(pong, options.now());
      }) ?? null;
    schedulePing();
    const source = context.createMediaStreamSource(media);
    // One mono channel: the first channel of whatever the mic gives.
    const splitter = context.createChannelSplitter(1);
    source.connect(splitter);
    const made = await options.createPitchNode(context, (reading) => {
      const handledMs = options.now();
      const stamped =
        session === live ? live.stampReading(reading, handledMs) : null;
      const offset = stamped ? live.offsetMs() : null;
      // The stamp is the window centre on the Stage's clock: back on this
      // page's clock and moved to the window's end, what is left of the
      // handling time is the wait beyond the quickest reading's.
      const workletWaitMs =
        stamped && offset !== null
          ? handledMs -
            (stamped.captureMs - offset) -
            (HALF_WINDOW_FRAMES / reading.sampleRate) * 1000
          : null;
      options.onWorkletReading?.(reading, { handledMs, workletWaitMs });
      if (stamped) options.deliver(stamped);
    });
    node = made;
    splitter.connect(made as unknown as AudioNode, 0);
  } catch (error) {
    release();
    throw error;
  }

  return {
    restartSync() {
      session?.restartSync(options.now());
      schedulePing();
    },
    offsetMs: () => session?.offsetMs() ?? null,
    info() {
      // Fakes in tests, and old browsers, may lack either method.
      const media: Partial<Pick<MediaStream, "getAudioTracks">> | null = stream;
      const track = media?.getAudioTracks?.()[0] ?? null;
      const readable: Partial<Pick<MediaStreamTrack, "getSettings">> | null =
        track;
      const latency = (seconds: number | undefined) =>
        typeof seconds === "number" && Number.isFinite(seconds)
          ? seconds * 1000
          : null;
      return {
        sampleRate: context.sampleRate,
        baseLatencyMs: latency(context.baseLatency),
        outputLatencyMs: latency(context.outputLatency),
        requested,
        settings: readable?.getSettings?.() ?? null,
        label: track?.label ?? null,
        muted: track ? track.muted : null,
        readyState: track ? track.readyState : null,
      };
    },
    stop: release,
  };
}
