// The Stage browser's own capture of its input devices (v1 spec #51,
// "Capture in the Stage browser"): lists them, opens each with every kind of
// processing off and 2 channels asked for, splits it into its channels, and
// meters each channel. Each channel runs its own pitch node (the shared
// pitch-detection worklet, `pitch/worklet/`), metering only until it is told
// to detect (`setDetecting`: while its Local mic is seated in a playing
// Song); its meter shows the loudness of the newest reading or level. Each
// channel's readings are stamped on the page's `performance.now()` with its
// own Local sender session (offset 0, the lower envelope of arrival − frame
// time, afresh for every new stream and each time the channel starts
// detecting) and handed to `subscribeReadings`.
// The capture keeps an `AudioContext` of its own, apart from the Song's: the
// envelope maps any context's frames onto the page clock, and the meters run
// without waiting for the Song chain.
// Which devices to open is decided by `devicesToOpen` (`localMics.ts`); this
// module only does what it is told. It never reads or changes an
// interface's PipeWire profile: the browser cannot.

import { browserInputDevices, type BrowserDevice } from "./localMics";
import type { PitchReading } from "../generated/PitchReading";
import {
  loadCaptureClock,
  type CaptureClock,
  type SenderSession,
} from "../pitch/clock/senderSession";
import {
  createPitchNode as createWorkletPitchNode,
  setDetecting as setNodeDetecting,
  type PitchNodeOptions,
  type PitchWorkletReading,
} from "../pitch/worklet/pitchWorklet";

/** What a meter shows for silence, and the floor of `levelDbfs`. */
export const SILENCE_DBFS = -100;

/** The constraints a device is opened with: no processing, 2 channels. */
export function captureConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: { exact: deviceId },
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  };
}

export type CaptureStatus =
  /** Not listed yet. */
  | "idle"
  /** The page may not read the microphone yet: device ids are hidden. */
  | "needsPermission"
  | "ready"
  /** The page cannot read its microphones: `unavailableCause` says why. */
  | "unavailable";

/** Why the capture is `unavailable`, each with its own fix on the Mics screen. */
export type UnavailableCause =
  /** Not a secure context (plain http:// other than localhost): no `mediaDevices`. */
  | "insecureContext"
  /** A secure context without `mediaDevices`: the browser does not support it. */
  | "noMediaDevices"
  /** The browser, or the person, refused the microphone permission. */
  | "permissionDenied"
  /** There is no input device to ask for. */
  | "noDevice";

export interface CaptureSnapshot {
  status: CaptureStatus;
  /**
   * Why `status` is `unavailable`; missing for any other status, and for a
   * refusal of no known kind.
   */
  unavailableCause?: UnavailableCause | undefined;
  devices: readonly BrowserDevice[];
  /** Open devices and the number of channels each opened with (1 or 2). */
  open: ReadonlyMap<string, number>;
  /**
   * The input delay each open device's track reports (its `latency`), ms;
   * a device that reports none is left out. An uncalibrated Local mic's
   * default Mic delay (#210).
   */
  inputDelaysMs?: ReadonlyMap<string, number>;
}

/**
 * The Stage's capture, as the Mics screen and the Stage use it. Making one
 * touches no device: nothing is listed or opened until it is told to.
 */
export interface LocalMicCapture {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CaptureSnapshot;
  /**
   * Lists the devices again. With `askPermission`, a page that may not read
   * the microphone yet asks for it first (Chromium hides device ids until then).
   */
  refresh: (askPermission: boolean) => Promise<void>;
  /** Opens exactly these devices, closing every other. */
  setOpen: (deviceIds: ReadonlySet<string>) => Promise<void>;
  /**
   * A channel's current level in dBFS: the newest reading's loudness, floored
   * at {@link SILENCE_DBFS}; `null` if its device is not open.
   */
  levelDbfs: (deviceId: string, channel: number) => number | null;
  /**
   * Whether a channel's newest window was exact digital silence (every
   * sample 0); `null` if its device is not open or nothing came yet.
   */
  digitalZero: (deviceId: string, channel: number) => boolean | null;
  /**
   * Runs the detector of exactly these channels (open now or later); every
   * other channel only meters.
   */
  setDetecting: (channels: Iterable<CaptureChannel>) => void;
  /**
   * Every Pitch reading of every detecting channel, stamped on the page's
   * clock (`now`), as the Pitch router takes it.
   */
  subscribeReadings: (listener: ReadingListener) => () => void;
  /** Closes everything; a later call starts again (React may remount). */
  dispose: () => void;
}

type Devices = Pick<
  MediaDevices,
  | "enumerateDevices"
  | "getUserMedia"
  | "addEventListener"
  | "removeEventListener"
>;

/** One channel of a device. */
export interface CaptureChannel {
  deviceId: string;
  channel: number;
}

export type ReadingListener = (
  deviceId: string,
  channel: number,
  reading: PitchReading,
) => void;

/** Makes a pitch node: `createPitchNode` of `pitch/worklet/pitchWorklet.ts`. */
export type CreatePitchNode = (
  context: BaseAudioContext,
  onReading: (reading: PitchWorkletReading) => void,
  options?: PitchNodeOptions,
) => Promise<AudioWorkletNode>;

const channelKey = (deviceId: string, channel: number) =>
  `${deviceId}\n${String(channel)}`;

interface OpenDevice {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  nodes: AudioWorkletNode[];
  /** Each channel's sender session; none when the capture clock failed. */
  sessions: SenderSession[];
  /** Each channel's newest loudness, dBFS; `null` before its first reading. */
  levels: (number | null)[];
  /** Each channel's newest window's `zero`; `null` before the first. */
  zeros: (boolean | null)[];
  /** The input delay its track reports, ms (`null`: none). */
  inputDelayMs: number | null;
}

/** `navigator.mediaDevices`, which is missing outside a secure context. */
function browserMediaDevices(): Devices | undefined {
  return "mediaDevices" in navigator ? navigator.mediaDevices : undefined;
}

/** The cause of a failed listing, from the `DOMException` the browser threw. */
function refusalCause(error: unknown): UnavailableCause | undefined {
  // A `DOMException` is not an `Error` in every environment.
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? error.name
      : undefined;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permissionDenied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "noDevice";
    default:
      return undefined;
  }
}

export function createLocalMicCapture({
  mediaDevices = browserMediaDevices(),
  secureContext = globalThis.isSecureContext,
  createContext = () => new AudioContext(),
  createPitchNode = createWorkletPitchNode,
  captureClock = loadCaptureClock,
  now = () => performance.now(),
}: {
  mediaDevices?: Devices | undefined;
  /** Whether the page is a secure context: tells apart why `mediaDevices` is missing. */
  secureContext?: boolean;
  createContext?: () => AudioContext;
  createPitchNode?: CreatePitchNode;
  captureClock?: () => Promise<CaptureClock>;
  /** The page clock readings are stamped on, ms. */
  now?: () => number;
} = {}): LocalMicCapture {
  let snapshot: CaptureSnapshot = {
    status: mediaDevices ? "idle" : "unavailable",
    unavailableCause: mediaDevices
      ? undefined
      : secureContext
        ? "noMediaDevices"
        : "insecureContext",
    devices: [],
    open: new Map(),
  };
  const listeners = new Set<() => void>();
  const readingListeners = new Set<ReadingListener>();
  const opened = new Map<string, OpenDevice>();
  let context: AudioContext | null = null;
  let wanted: ReadonlySet<string> = new Set();
  /** `channelKey`s whose detector runs. */
  let detecting = new Set<string>();
  let listening = false;
  // Opens and closes run one after another.
  let queue: Promise<void> = Promise.resolve();

  function update(next: Partial<CaptureSnapshot>) {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  function publishOpen() {
    update({
      open: new Map(
        [...opened].map(([id, device]) => [id, device.nodes.length]),
      ),
      inputDelaysMs: new Map(
        [...opened].flatMap(([id, device]) =>
          device.inputDelayMs === null ? [] : [[id, device.inputDelayMs]],
        ),
      ),
    });
  }

  // A plugged or unplugged device lists the devices again.
  const onDeviceChange = () => {
    void list(false);
  };

  async function list(askPermission: boolean) {
    if (!mediaDevices) return;
    if (!listening) {
      listening = true;
      mediaDevices.addEventListener("devicechange", onDeviceChange);
    }
    try {
      let devices = browserInputDevices(await mediaDevices.enumerateDevices());
      if (devices.length === 0 && askPermission) {
        const stream = await mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        devices = browserInputDevices(await mediaDevices.enumerateDevices());
      }
      const hidden = devices.length === 0 && !askPermission;
      update({
        status: hidden ? "needsPermission" : "ready",
        unavailableCause: undefined,
        devices,
      });
    } catch (error) {
      update({ status: "unavailable", unavailableCause: refusalCause(error) });
    }
  }

  function close(deviceId: string) {
    const device = opened.get(deviceId);
    if (!device) return;
    opened.delete(deviceId);
    device.source.disconnect();
    for (const node of device.nodes) {
      node.disconnect();
      node.port.close();
    }
    for (const session of device.sessions) session.dispose();
    for (const track of device.stream.getTracks()) track.stop();
  }

  async function open(deviceId: string) {
    if (!mediaDevices || opened.has(deviceId)) return;
    const stream = await mediaDevices.getUserMedia(
      captureConstraints(deviceId),
    );
    if (!wanted.has(deviceId)) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const audio = (context ??= createContext());
    const [track] = stream.getAudioTracks();
    const settings: MediaTrackSettings & { latency?: number } =
      track?.getSettings() ?? {};
    const channels = Math.min(2, Math.max(1, settings.channelCount ?? 1));
    const inputDelayMs =
      typeof settings.latency === "number" && Number.isFinite(settings.latency)
        ? Math.max(0, settings.latency * 1000)
        : null;
    const levels: (number | null)[] = Array.from(
      { length: channels },
      () => null,
    );
    const zeros: (boolean | null)[] = levels.map(() => null);
    // Without the capture clock the meters still run; readings are dropped.
    const clock = await captureClock().catch(() => null);
    const sessions = clock ? levels.map(() => clock.local()) : [];
    let nodes: AudioWorkletNode[];
    try {
      nodes = await Promise.all(
        levels.map((_, channel) =>
          createPitchNode(
            audio,
            (reading) => {
              levels[channel] = reading.loudness;
              zeros[channel] = reading.zero;
              const stamped = sessions[channel]?.stampReading(reading, now());
              if (!stamped) return;
              for (const listener of readingListeners)
                listener(deviceId, channel, stamped);
            },
            {
              detect: detecting.has(channelKey(deviceId, channel)),
              onLevel: (level) => {
                levels[channel] = level.loudness;
                zeros[channel] = level.zero;
              },
            },
          ),
        ),
      );
    } catch (error) {
      for (const session of sessions) session.dispose();
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
    if (!wanted.has(deviceId)) {
      for (const node of nodes) node.port.close();
      for (const session of sessions) session.dispose();
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // A new stream: each channel's frame mapping starts afresh.
    const startedAt = now();
    for (const session of sessions) session.startCapture(startedAt);
    const source = audio.createMediaStreamSource(stream);
    const splitter = audio.createChannelSplitter(channels);
    source.connect(splitter);
    nodes.forEach((node, channel) => splitter.connect(node, channel));
    opened.set(deviceId, {
      stream,
      source,
      nodes,
      sessions,
      levels,
      zeros,
      inputDelayMs,
    });
    // `setDetecting` may have changed while this device was opening.
    nodes.forEach((node, channel) => {
      setNodeDetecting(node, detecting.has(channelKey(deviceId, channel)));
    });
  }

  async function sync() {
    for (const id of [...opened.keys()]) if (!wanted.has(id)) close(id);
    for (const id of wanted) {
      try {
        await open(id);
      } catch {
        // A device that will not open (unplugged meanwhile) stays closed.
      }
    }
    publishOpen();
    if (context?.state === "suspended") await context.resume().catch(() => {});
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: (askPermission) => list(askPermission),
    setOpen(deviceIds) {
      wanted = new Set(deviceIds);
      queue = queue.then(sync);
      return queue;
    },
    levelDbfs(deviceId, channel) {
      const device = opened.get(deviceId);
      if (!device || channel >= device.nodes.length) return null;
      return Math.max(SILENCE_DBFS, device.levels[channel] ?? SILENCE_DBFS);
    },
    digitalZero(deviceId, channel) {
      return opened.get(deviceId)?.zeros[channel] ?? null;
    },
    setDetecting(channels) {
      const next = new Set<string>();
      for (const { deviceId, channel } of channels)
        next.add(channelKey(deviceId, channel));
      for (const [deviceId, device] of opened) {
        device.nodes.forEach((node, channel) => {
          const key = channelKey(deviceId, channel);
          if (next.has(key) === detecting.has(key)) return;
          setNodeDetecting(node, next.has(key));
          // A Song starts with this channel: its frame mapping starts
          // afresh, as a Phone's does at Sing again. While it only meters,
          // no reading kept the envelope up to date.
          if (next.has(key)) device.sessions[channel]?.startCapture(now());
        });
      }
      detecting = next;
    },
    subscribeReadings(listener) {
      readingListeners.add(listener);
      return () => readingListeners.delete(listener);
    },
    dispose() {
      wanted = new Set();
      if (listening) {
        listening = false;
        mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      }
      for (const id of [...opened.keys()]) close(id);
      void context?.close().catch(() => {});
      context = null;
      publishOpen();
    },
  };
}
