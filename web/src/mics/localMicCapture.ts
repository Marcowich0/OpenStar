// The Stage browser's own capture of its input devices (v1 spec #51,
// "Capture in the Stage browser"): lists them, opens each with every kind of
// processing off and 2 channels asked for, splits it into its channels, and
// meters each channel. Meters use an `AnalyserNode` per channel (level only,
// no detector) until the pitch-detection worklet carries them (#130).
// Which devices to open is decided by `devicesToOpen` (`localMics.ts`); this
// module only does what it is told. It never reads or changes an
// interface's PipeWire profile: the browser cannot.

import { browserInputDevices, type BrowserDevice } from "./localMics";

/** What a meter shows for silence, and the floor of `levelDbfs`. */
export const SILENCE_DBFS = -100;

/** The level of a block of samples: RMS in dBFS, floored at {@link SILENCE_DBFS}. */
export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) return SILENCE_DBFS;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0) return SILENCE_DBFS;
  return Math.max(SILENCE_DBFS, 20 * Math.log10(rms));
}

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
  /** No `mediaDevices` (not a secure context) or the browser refused. */
  | "unavailable";

export interface CaptureSnapshot {
  status: CaptureStatus;
  devices: readonly BrowserDevice[];
  /** Open devices and the number of channels each opened with (1 or 2). */
  open: ReadonlyMap<string, number>;
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
  /** A channel's current level in dBFS, or `null` if its device is not open. */
  levelDbfs: (deviceId: string, channel: number) => number | null;
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

interface OpenDevice {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analysers: AnalyserNode[];
  buffer: Float32Array<ArrayBuffer>;
}

const FFT_SIZE = 2048;

/** `navigator.mediaDevices`, which is missing outside a secure context. */
function browserMediaDevices(): Devices | undefined {
  return "mediaDevices" in navigator ? navigator.mediaDevices : undefined;
}

export function createLocalMicCapture({
  mediaDevices = browserMediaDevices(),
  createContext = () => new AudioContext(),
}: {
  mediaDevices?: Devices | undefined;
  createContext?: () => AudioContext;
} = {}): LocalMicCapture {
  let snapshot: CaptureSnapshot = {
    status: mediaDevices ? "idle" : "unavailable",
    devices: [],
    open: new Map(),
  };
  const listeners = new Set<() => void>();
  const opened = new Map<string, OpenDevice>();
  let context: AudioContext | null = null;
  let wanted: ReadonlySet<string> = new Set();
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
        [...opened].map(([id, device]) => [id, device.analysers.length]),
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
      update({ status: hidden ? "needsPermission" : "ready", devices });
    } catch {
      update({ status: "unavailable" });
    }
  }

  function close(deviceId: string) {
    const device = opened.get(deviceId);
    if (!device) return;
    opened.delete(deviceId);
    device.source.disconnect();
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
    const channels = Math.min(
      2,
      Math.max(1, track?.getSettings().channelCount ?? 1),
    );
    const source = audio.createMediaStreamSource(stream);
    const splitter = audio.createChannelSplitter(channels);
    source.connect(splitter);
    const analysers = Array.from({ length: channels }, (_, channel) => {
      const analyser = audio.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      splitter.connect(analyser, channel);
      return analyser;
    });
    opened.set(deviceId, {
      stream,
      source,
      analysers,
      buffer: new Float32Array(FFT_SIZE),
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
      const analyser = device?.analysers[channel];
      if (!device || !analyser) return null;
      analyser.getFloatTimeDomainData(device.buffer);
      return rmsDbfs(device.buffer);
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
