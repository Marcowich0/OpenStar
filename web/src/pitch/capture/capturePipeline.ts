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

/**
 * The spec's constraints for a Phone mic: the browser's echo cancellation
 * and noise suppression on, auto gain off, one channel.
 */
export const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  },
  video: false,
} as const satisfies MediaStreamConstraints;

/** What the pipeline uses of an `AudioContext`. */
export type CaptureAudioContext = Pick<
  AudioContext,
  | "sampleRate"
  | "resume"
  | "close"
  | "createMediaStreamSource"
  | "createChannelSplitter"
>;

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
  onWorkletReading?: (reading: PitchWorkletReading) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface CapturePipeline {
  /** The WebSocket connected again: sync starts afresh (#129). */
  restartSync: () => void;
  /** Stage clock − page clock; null before an offset exists (0 when local). */
  offsetMs: () => number | null;
  /** Releases the mic, the context and the clock session. */
  stop: () => void;
}

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
  const opened = options.getUserMedia(MIC_CONSTRAINTS);

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
      options.onWorkletReading?.(reading);
      if (session !== live) return;
      const stamped = live.stampReading(reading, options.now());
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
    stop: release,
  };
}
