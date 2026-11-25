// The Stage output: which sound output the Stage plays to. There is no
// output picker; the Stage plays to the system default output, and its
// output key is that output's label without "Default - ". Mic delays, bleed
// levels and Mic thresholds (#52), the A/V offset (#161) and the OpenStar
// volume all key on it. A changed label is a new output, with no re-link.

const DEFAULT_PREFIX = "Default - ";

/**
 * The output key: the label of the default `audiooutput` entry (Chromium's
 * `deviceId` "default") with the prefix "Default - " removed. Without a
 * default entry, the first output's label. Empty when the browser hides the
 * labels (no microphone permission) or lists no output.
 */
export function outputKey(devices: readonly MediaDeviceInfo[]): string {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const output = outputs.find((d) => d.deviceId === "default") ?? outputs[0];
  const label = output?.label ?? "";
  return label.startsWith(DEFAULT_PREFIX)
    ? label.slice(DEFAULT_PREFIX.length)
    : label;
}

/** No media devices (an insecure page): no label, so the key is "". */
export const NO_DEVICES: OutputDevices = {
  enumerateDevices: () => Promise.resolve([]),
  getUserMedia: () => Promise.reject(new Error("no media devices")),
  addEventListener: () => {},
  removeEventListener: () => {},
};

/** The part of `navigator.mediaDevices` the watcher needs. */
export type OutputDevices = Pick<
  MediaDevices,
  "enumerateDevices" | "getUserMedia"
> & {
  addEventListener(type: "devicechange", listener: () => void): void;
  removeEventListener(type: "devicechange", listener: () => void): void;
};

export interface StageOutputWatcher {
  /** The current output key, or `null` before the first read or once stopped. */
  current: () => string | null;
  /** Calls `listener` whenever the current key is read anew or changes. */
  subscribe: (listener: () => void) => () => void;
  /**
   * The output-changed event: called once per label change, with the new
   * and the previous key (never for the first read after `start`).
   */
  onOutputChanged: (
    listener: (key: string, previous: string) => void,
  ) => () => void;
  /**
   * Reads the key, first asking for the microphone (and releasing it at
   * once) when the labels are hidden, as Chromium hides them until it is
   * granted; then reads it again on every `devicechange` until `stop`.
   */
  start: () => void;
  /** Stops reading; the key is unknown again. */
  stop: () => void;
}

/** Watches the Stage output while the browser is the Stage. */
export function createStageOutputWatcher(
  devices: OutputDevices,
): StageOutputWatcher {
  let key: string | null = null;
  let running = false;
  // Every start and every read gets a number; only the newest one's answer counts.
  let reads = 0;
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(key: string, previous: string) => void>();

  // A function, so a check after an `await` reads the flag anew.
  const stopped = () => !running;

  function told() {
    for (const listener of listeners) listener();
  }

  async function read() {
    const mine = ++reads;
    let list: MediaDeviceInfo[];
    try {
      list = await devices.enumerateDevices();
    } catch {
      return;
    }
    if (!running || mine !== reads) return;
    const next = outputKey(list);
    const previous = key;
    if (previous === next) return;
    key = next;
    told();
    if (previous !== null) {
      for (const listener of changeListeners) listener(next, previous);
    }
  }

  const onDeviceChange = () => {
    void read();
  };

  async function askThenRead() {
    // Labels are readable once the microphone was granted: then no prompt.
    const visible = await devices
      .enumerateDevices()
      .then((list) => outputKey(list) !== "")
      .catch(() => false);
    if (stopped()) return;
    if (!visible) {
      try {
        const stream = await devices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
      } catch {
        // Refused or no microphone: the label stays hidden; the key is "".
      }
      if (stopped()) return;
    }
    devices.addEventListener("devicechange", onDeviceChange);
    await read();
  }

  return {
    current: () => key,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onOutputChanged(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    start() {
      if (running) return;
      running = true;
      void askThenRead();
    },
    stop() {
      if (!running) return;
      running = false;
      reads++;
      devices.removeEventListener("devicechange", onDeviceChange);
      if (key !== null) {
        key = null;
        told();
      }
    },
  };
}
