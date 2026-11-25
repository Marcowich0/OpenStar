import { describe, expect, it, vi } from "vitest";

import {
  SILENCE_DBFS,
  createLocalMicCapture,
  rmsDbfs,
} from "./localMicCapture";

interface FakeDevice {
  deviceId: string;
  label: string;
  channels: number;
}

/** A browser's `mediaDevices` and `AudioContext`, with devices to open. */
function fakeBrowser(devices: FakeDevice[], { granted = true } = {}) {
  let permission = granted;
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
      const channelCount =
        devices.find((d) => d.deviceId === id)?.channels ?? 1;
      const track = {
        getSettings: () => ({ channelCount }),
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
  const context = {
    state: "running",
    createMediaStreamSource: vi.fn(node),
    createChannelSplitter: vi.fn(node),
    createAnalyser: vi.fn(() => ({
      ...node(),
      fftSize: 0,
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.5),
    })),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const capture = createLocalMicCapture({
    mediaDevices: mediaDevices as unknown as MediaDevices,
    createContext: () => context as unknown as AudioContext,
  });
  return { capture, mediaDevices, opened, stopped };
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

  it("splits a stereo device into two metered channels and a mono device into one", async () => {
    const { capture } = fakeBrowser([DONGLE, WEBCAM]);
    await capture.setOpen(new Set(["dongle", "webcam"]));
    expect(capture.getSnapshot().open).toEqual(
      new Map([
        ["dongle", 2],
        ["webcam", 1],
      ]),
    );
    expect(capture.levelDbfs("dongle", 1)).toBeCloseTo(-6.02, 1);
    expect(capture.levelDbfs("webcam", 1)).toBeNull();
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
  it("is the RMS in dBFS", () => {
    expect(rmsDbfs(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0);
    expect(rmsDbfs(new Float32Array(8).fill(0.1))).toBeCloseTo(-20);
  });

  it("is the floor for digital silence", () => {
    expect(rmsDbfs(new Float32Array(8))).toBe(SILENCE_DBFS);
  });
});
