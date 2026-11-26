import { describe, expect, it, vi } from "vitest";

import { SILENCE_DBFS, createLocalMicCapture } from "./localMicCapture";
import type { PitchReading } from "../generated/PitchReading";
import { realCaptureClock } from "../pitch/capture/testCapture";
import type {
  PitchNodeOptions,
  PitchWorkletReading,
} from "../pitch/worklet/pitchWorklet";

interface FakeDevice {
  deviceId: string;
  label: string;
  channels: number;
  /** The track's reported `latency`, seconds, if any. */
  latency?: number;
}

/** A browser's `mediaDevices` and `AudioContext`, with devices to open. */
function fakeBrowser(devices: FakeDevice[], { granted = true } = {}) {
  let permission = granted;
  /** The page clock, ms; tests move it. */
  const clock = { now: 0 };
  const stopped: string[] = [];
  const opened: MediaStreamConstraints[] = [];
  const mediaDevices = {
    enumerateDevices: vi.fn(() =>
      Promise.resolve(
        [
          { deviceId: "default", label: "Default", kind: "audioinput" },
          ...devices.map((d) => ({
            deviceId: d.deviceId,
            label: d.label,
            kind: "audioinput",
          })),
        ].map((d) => (permission ? d : { ...d, deviceId: "", label: "" })),
      ),
    ),
    getUserMedia: vi.fn((constraints: MediaStreamConstraints) => {
      permission = true;
      opened.push(constraints);
      const audio = constraints.audio;
      const id =
        typeof audio === "object"
          ? (audio.deviceId as { exact: string }).exact
          : "any";
      const device = devices.find((d) => d.deviceId === id);
      const channelCount = device?.channels ?? 1;
      const latency = device?.latency;
      const track = {
        getSettings: () =>
          latency === undefined ? { channelCount } : { channelCount, latency },
        stop: () => stopped.push(id),
      };
      return Promise.resolve({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      });
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const splitters: ReturnType<typeof node>[] = [];
  const context = {
    state: "running",
    createMediaStreamSource: vi.fn(node),
    createChannelSplitter: vi.fn(() => {
      const splitter = node();
      splitters.push(splitter);
      return splitter;
    }),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  /** Every pitch node made, with the hook that plays the worklet posting a reading. */
  const pitchNodes: {
    node: ReturnType<typeof node> & {
      port: { close: () => void; postMessage: (m: unknown) => void };
    };
    closed: boolean;
    /** Whether its detector runs: as made, then as commanded. */
    detecting: boolean;
    post: (reading: Partial<PitchWorkletReading>) => void;
    postLevel: (loudness: number, zero?: boolean) => void;
  }[] = [];
  const capture = createLocalMicCapture({
    mediaDevices: mediaDevices as unknown as MediaDevices,
    createContext: () => context as unknown as AudioContext,
    captureClock: realCaptureClock,
    now: () => clock.now,
    createPitchNode: (_context, onReading, options?: PitchNodeOptions) => {
      const made = {
        node: {
          ...node(),
          port: {
            close: () => (made.closed = true),
            postMessage: (m: unknown) => {
              made.detecting = (m as { on: boolean }).on;
            },
          },
        },
        closed: false,
        detecting: options?.detect ?? true,
        postLevel: (loudness: number, zero = false) => {
          options?.onLevel?.({ type: "level", loudness, zero, endFrame: 2048 });
        },
        post: (reading: Partial<PitchWorkletReading>) => {
          onReading({
            type: "reading",
            pitch: null,
            clarity: 0,
            loudness: -120,
            zero: false,
            endFrame: 2048,
            sampleRate: 48_000,
            ...reading,
          });
        },
      };
      pitchNodes.push(made);
      return Promise.resolve(made.node as unknown as AudioWorkletNode);
    },
  });
  return {
    capture,
    mediaDevices,
    opened,
    stopped,
    pitchNodes,
    splitters,
    clock,
  };
}

const DONGLE = { deviceId: "dongle", label: "USB Audio", channels: 2 };
const WEBCAM = { deviceId: "webcam", label: "Webcam Mic", channels: 1 };

describe("the Stage browser's capture", () => {
  it("lists its input devices without Chromium's default entry", async () => {
    const { capture } = fakeBrowser([DONGLE, WEBCAM]);
    await capture.refresh(false);
    expect(capture.getSnapshot()).toMatchObject({
      status: "ready",
      devices: [
        { deviceId: "dongle", label: "USB Audio" },
        { deviceId: "webcam", label: "Webcam Mic" },
      ],
    });
  });

  it("asks for the microphone only when told to, then lists", async () => {
    const browser = fakeBrowser([DONGLE], { granted: false });
    await browser.capture.refresh(false);
    expect(browser.capture.getSnapshot().status).toBe("needsPermission");
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();

    await browser.capture.refresh(true);
    expect(browser.capture.getSnapshot().devices).toHaveLength(1);
    // The permission stream is closed again at once.
    expect(browser.stopped).toEqual(["any"]);
  });

  it("opens a device with echo cancellation, noise suppression and auto gain off, asking for 2 channels", async () => {
    const { capture, opened } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    expect(opened).toEqual([
      {
        audio: {
          deviceId: { exact: "dongle" },
          channelCount: { ideal: 2 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      },
    ]);
  });

  it("splits a stereo device into two channels and a mono device into one, each with its own pitch node", async () => {
    const { capture, pitchNodes, splitters } = fakeBrowser([DONGLE, WEBCAM]);
    await capture.setOpen(new Set(["dongle", "webcam"]));
    expect(capture.getSnapshot().open).toEqual(
      new Map([
        ["dongle", 2],
        ["webcam", 1],
      ]),
    );
    expect(pitchNodes).toHaveLength(3);
    expect(splitters[0]?.connect.mock.calls).toEqual([
      [pitchNodes[0]?.node, 0],
      [pitchNodes[1]?.node, 1],
    ]);
    expect(capture.levelDbfs("webcam", 1)).toBeNull();
  });

  it("keeps each open device's reported input delay, in ms, while it is open", async () => {
    const { capture } = fakeBrowser([{ ...DONGLE, latency: 0.0125 }, WEBCAM]);
    await capture.setOpen(new Set(["dongle", "webcam"]));
    expect(capture.getSnapshot().inputDelaysMs).toEqual(
      new Map([["dongle", 12.5]]),
    );
    await capture.setOpen(new Set(["webcam"]));
    expect(capture.getSnapshot().inputDelaysMs).toEqual(new Map());
  });

  it("closes a closed device's pitch nodes", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    await capture.setOpen(new Set());
    expect(pitchNodes.map((n) => n.closed)).toEqual([true, true]);
    expect(pitchNodes[0]?.node.disconnect).toHaveBeenCalled();
  });

  it("closes what it is no longer told to keep open", async () => {
    const { capture, stopped } = fakeBrowser([DONGLE, WEBCAM]);
    await capture.setOpen(new Set(["dongle", "webcam"]));
    await capture.setOpen(new Set(["dongle"]));
    expect(stopped).toEqual(["webcam"]);
    expect([...capture.getSnapshot().open.keys()]).toEqual(["dongle"]);
    expect(capture.levelDbfs("webcam", 0)).toBeNull();
  });

  it("reports itself unavailable without mediaDevices (not a secure context)", () => {
    const capture = createLocalMicCapture({ mediaDevices: undefined });
    expect(capture.getSnapshot().status).toBe("unavailable");
  });
});

describe("a channel's level", () => {
  it("is the loudness of its newest Pitch reading", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    pitchNodes[1]?.post({ loudness: -30 });
    pitchNodes[1]?.post({ loudness: -6.5 });
    expect(capture.levelDbfs("dongle", 1)).toBe(-6.5);
  });

  it("is the floor before the first reading and for digital silence", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    expect(capture.levelDbfs("dongle", 0)).toBe(SILENCE_DBFS);
    pitchNodes[0]?.post({ loudness: -120 });
    expect(capture.levelDbfs("dongle", 0)).toBe(SILENCE_DBFS);
  });
});

describe("a channel's digital silence", () => {
  it("is unknown until the channel's first window, and for a closed device", async () => {
    const { capture } = fakeBrowser([DONGLE]);
    expect(capture.digitalZero("dongle", 0)).toBeNull();
    await capture.setOpen(new Set(["dongle"]));
    expect(capture.digitalZero("dongle", 0)).toBeNull();
  });

  it("follows the newest level or reading, per channel", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    pitchNodes[0]?.postLevel(-120, true);
    pitchNodes[1]?.postLevel(-120, false);
    expect(capture.digitalZero("dongle", 0)).toBe(true);
    expect(capture.digitalZero("dongle", 1)).toBe(false);
    pitchNodes[0]?.post({ loudness: -40, zero: false });
    expect(capture.digitalZero("dongle", 0)).toBe(false);
    await capture.setOpen(new Set());
    expect(capture.digitalZero("dongle", 0)).toBeNull();
  });
});

describe("which detectors run", () => {
  it("none at first: every channel opens metering only, and its level moves", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    expect(pitchNodes.map((n) => n.detecting)).toEqual([false, false]);
    pitchNodes[1]?.postLevel(-25);
    expect(capture.levelDbfs("dongle", 1)).toBe(-25);
  });

  it("exactly the channels named, opened before or after, and the meters keep running", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE, WEBCAM]);
    await capture.setOpen(new Set(["dongle"]));
    capture.setDetecting([{ deviceId: "dongle", channel: 1 }]);
    expect(pitchNodes.map((n) => n.detecting)).toEqual([false, true]);

    capture.setDetecting([
      { deviceId: "dongle", channel: 0 },
      { deviceId: "webcam", channel: 0 },
    ]);
    await capture.setOpen(new Set(["dongle", "webcam"]));
    expect(pitchNodes.map((n) => n.detecting)).toEqual([true, false, true]);

    pitchNodes[1]?.postLevel(-33);
    pitchNodes[0]?.post({ loudness: -12 });
    expect(capture.levelDbfs("dongle", 1)).toBe(-33);
    expect(capture.levelDbfs("dongle", 0)).toBe(-12);

    capture.setDetecting([]);
    expect(pitchNodes.map((n) => n.detecting)).toEqual([false, false, false]);
  });
});

describe("the readings", () => {
  async function listening() {
    const browser = fakeBrowser([DONGLE]);
    browser.clock.now = 50;
    await browser.capture.setOpen(new Set(["dongle"]));
    const heard: [string, number, PitchReading][] = [];
    browser.capture.subscribeReadings((deviceId, channel, r) =>
      heard.push([deviceId, channel, r]),
    );
    return { ...browser, heard };
  }

  /** Half the detector's window at 48 kHz, ms: a window's centre. */
  const HALF_WINDOW_MS = 1024 / 48;

  it("are stamped on the page clock by the lower envelope of arrival − frame time, with no clock offset", async () => {
    const { pitchNodes, clock, heard } = await listening();
    // Frame time 100 ms arrives at 101 ms, then 110 ms arrives late at 115.
    clock.now = 101;
    pitchNodes[0]?.post({ endFrame: 4800, pitch: 69, loudness: -20 });
    clock.now = 115;
    pitchNodes[0]?.post({ endFrame: 5280, pitch: 70, loudness: -21 });
    expect(heard.map(([, , r]) => r.captureMs)).toEqual([
      expect.closeTo(101 - HALF_WINDOW_MS, 9),
      expect.closeTo(111 - HALF_WINDOW_MS, 9),
    ]);
    expect(heard[1]?.[2]).toMatchObject({ pitch: 70, loudness: -21 });
  });

  it("start a fresh envelope on a new capture stream", async () => {
    const { capture, pitchNodes, clock, heard } = await listening();
    clock.now = 101;
    pitchNodes[0]?.post({ endFrame: 4800 });
    await capture.setOpen(new Set());
    await capture.setOpen(new Set(["dongle"]));
    // The new stream's readings arrive 10 ms after their frame time: with
    // the old envelope they would be stamped 9 ms early.
    clock.now = 130;
    pitchNodes[2]?.post({ endFrame: 5760 });
    expect(heard.at(-1)?.[2].captureMs).toBeCloseTo(130 - HALF_WINDOW_MS, 9);
  });

  it("reach every subscriber with their device and channel", async () => {
    const { capture, pitchNodes } = fakeBrowser([DONGLE]);
    await capture.setOpen(new Set(["dongle"]));
    const heard: [string, number, number | null][] = [];
    const unsubscribe = capture.subscribeReadings((deviceId, channel, r) =>
      heard.push([deviceId, channel, r.pitch]),
    );
    pitchNodes[1]?.post({ pitch: 69, endFrame: 4800 });
    unsubscribe();
    pitchNodes[0]?.post({ pitch: 60 });
    expect(heard).toEqual([["dongle", 1, 69]]);
  });
});
