import { describe, expect, it, vi } from "vitest";

import { createStageOutputWatcher, outputKey } from "./stageOutput";

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "g", toJSON: () => ({}) };
}

const scarlett = [
  device("audioinput", "default", "Default - Microphone (Scarlett 4i4)"),
  device("audiooutput", "default", "Default - Speakers (Scarlett 4i4)"),
  device("audiooutput", "abc", "Speakers (Scarlett 4i4)"),
  device("audiooutput", "tv", "HDMI (LG TV)"),
];

describe("the output key", () => {
  it("is the default output's label without 'Default - '", () => {
    expect(outputKey(scarlett)).toBe("Speakers (Scarlett 4i4)");
  });

  it("keeps a label that has no prefix", () => {
    expect(outputKey([device("audiooutput", "default", "Built-in")])).toBe(
      "Built-in",
    );
  });

  it("is the first output's label when no entry is the default", () => {
    expect(
      outputKey([
        device("audioinput", "mic", "Mic"),
        device("audiooutput", "tv", "HDMI (LG TV)"),
      ]),
    ).toBe("HDMI (LG TV)");
  });

  it("is empty when the label is hidden or there is no output", () => {
    expect(outputKey([device("audiooutput", "default", "")])).toBe("");
    expect(outputKey([])).toBe("");
  });
});

/**
 * Fake `navigator.mediaDevices` over a sequence of device lists. Like
 * Chromium, it hides labels until the microphone is granted (unless
 * `granted` says it already was).
 */
function fakeDevices(lists: MediaDeviceInfo[][], { granted = false } = {}) {
  let current = lists[0] ?? [];
  let labels = granted;
  const listeners = new Set<() => void>();
  const getUserMedia = vi.fn(() => {
    labels = true;
    return Promise.resolve({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream);
  });
  return {
    getUserMedia,
    enumerateDevices: () =>
      Promise.resolve(
        labels ? current : current.map((d) => device(d.kind, d.deviceId, "")),
      ),
    addEventListener: (_: "devicechange", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: "devicechange", listener: () => void) => {
      listeners.delete(listener);
    },
    /** Moves to list `index` and fires `devicechange`. */
    change(index: number) {
      current = lists[index] ?? [];
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Stage output watcher", () => {
  it("touches no device until it starts", async () => {
    const devices = fakeDevices([scarlett]);
    createStageOutputWatcher(devices);
    await settle();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(devices.listeners.size).toBe(0);
  });

  it("asks for the microphone, then reads the key", async () => {
    const devices = fakeDevices([scarlett]);
    const watcher = createStageOutputWatcher(devices);
    watcher.start();
    const keys: string[] = [];
    watcher.subscribe(() => keys.push(watcher.current() ?? "none"));
    expect(watcher.current()).toBeNull();
    await settle();
    expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(watcher.current()).toBe("Speakers (Scarlett 4i4)");
    expect(keys).toEqual(["Speakers (Scarlett 4i4)"]);
    watcher.stop();
    expect(devices.listeners.size).toBe(0);
    expect(watcher.current()).toBeNull();
    expect(keys).toEqual(["Speakers (Scarlett 4i4)", "none"]);
  });

  it("asks for nothing when the labels are readable already", async () => {
    const devices = fakeDevices([scarlett], { granted: true });
    const watcher = createStageOutputWatcher(devices);
    watcher.start();
    await settle();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(watcher.current()).toBe("Speakers (Scarlett 4i4)");
    watcher.stop();
  });

  it("still reads the key when the microphone is refused", async () => {
    const devices = fakeDevices([[device("audiooutput", "default", "")]]);
    devices.getUserMedia.mockRejectedValue(new Error("NotAllowedError"));
    const watcher = createStageOutputWatcher(devices);
    watcher.start();
    await settle();
    expect(watcher.current()).toBe("");
    watcher.stop();
  });

  it("raises output-changed exactly once per label change, over a device sequence", async () => {
    const tv = scarlett.map((d) =>
      d.kind === "audiooutput" && d.deviceId === "default"
        ? device("audiooutput", "default", "Default - HDMI (LG TV)")
        : d,
    );
    const withHeadset = [...tv, device("audioinput", "h", "Headset")];
    const devices = fakeDevices([scarlett, scarlett, tv, withHeadset, tv]);
    const watcher = createStageOutputWatcher(devices);
    watcher.start();
    const changes: [string, string][] = [];
    watcher.onOutputChanged((key, previous) => changes.push([key, previous]));
    await settle();
    expect(changes).toEqual([]);

    for (const index of [1, 2, 2, 3, 4]) {
      devices.change(index);
      await settle();
    }
    expect(changes).toEqual([["HDMI (LG TV)", "Speakers (Scarlett 4i4)"]]);
    expect(watcher.current()).toBe("HDMI (LG TV)");
    watcher.stop();
  });

  it("drops a slow read that a newer one overtook", async () => {
    const tv = [device("audiooutput", "default", "Default - HDMI (LG TV)")];
    const resolvers: ((list: MediaDeviceInfo[]) => void)[] = [];
    const devices = {
      ...fakeDevices([scarlett], { granted: true }),
      enumerateDevices: () =>
        new Promise<MediaDeviceInfo[]>((resolve) => resolvers.push(resolve)),
    };
    const watcher = createStageOutputWatcher(devices);
    watcher.start();
    await settle();
    resolvers[0]?.(scarlett); // labels readable: the first read starts
    await settle();
    devices.change(0);
    await settle();
    // The second read answers first, then the first (older) one.
    resolvers[2]?.(tv);
    await settle();
    resolvers[1]?.(scarlett);
    await settle();
    expect(watcher.current()).toBe("HDMI (LG TV)");
    watcher.stop();
  });
});
