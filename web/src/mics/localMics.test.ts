import { describe, expect, it } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import {
  browserChannels,
  browserInputDevices,
  devicesToOpen,
  localMicName,
  micsScreenOrder,
  stageBrowserId,
  type BrowserChannel,
} from "./localMics";

function device(
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = "audioinput",
) {
  return { deviceId, label, kind, groupId: "g" };
}

function channel(
  deviceId: string,
  label: string,
  channelNumber: number,
  stereo = true,
): BrowserChannel {
  return browserChannels("stage", { deviceId, label }, stereo ? 2 : 1)[
    channelNumber
  ] as BrowserChannel;
}

function kept(c: BrowserChannel, switchedOn: boolean, name = ""): LocalMic {
  return { localMicId: c.localMicId, source: c.source, name, switchedOn };
}

describe("the Stage browser's input devices", () => {
  it("leave out Chromium's default and communications entries and every output", () => {
    expect(
      browserInputDevices([
        device("default", "Default - USB Audio"),
        device("communications", "Communications - USB Audio"),
        device("abc", "USB Audio"),
        device("out", "Speakers", "audiooutput"),
        device("def", "Webcam Mic"),
      ]),
    ).toEqual([
      { deviceId: "abc", label: "USB Audio" },
      { deviceId: "def", label: "Webcam Mic" },
    ]);
  });

  it("are none before the browser may read the microphone (no ids yet)", () => {
    expect(browserInputDevices([device("", "")])).toEqual([]);
  });
});

describe("a device's channels", () => {
  it("are Left and Right for a stereo device, each its own Local mic", () => {
    const [left, right] = browserChannels(
      "stage-1",
      { deviceId: "abc", label: "USB Audio" },
      2,
    );
    expect(left?.localMicId).toBe("browser:stage-1:abc:0");
    expect(right?.localMicId).toBe("browser:stage-1:abc:1");
    expect(right?.source).toEqual({
      kind: "browser",
      stageBrowser: "stage-1",
      deviceId: "abc",
      label: "USB Audio",
      channel: 1,
      stereo: true,
    });
  });

  it("are one Local mic for a mono device", () => {
    const channels = browserChannels(
      "s",
      { deviceId: "abc", label: "Mic" },
      1,
    );
    expect(channels.map((c) => c.localMicId)).toEqual(["browser:s:abc:0"]);
    expect(channels[0]?.source.stereo).toBe(false);
  });

  it("are at most two, whatever the device reports", () => {
    expect(
      browserChannels("s", { deviceId: "abc", label: "Mic" }, 4),
    ).toHaveLength(2);
  });
});

describe("a Local mic's name", () => {
  it("is the host's name when one is stored", () => {
    const left = channel("abc", "USB Audio", 0);
    expect(localMicName(left.source, "Red mic")).toBe("Red mic");
  });

  it("defaults to '<label> · Left' and '<label> · Right' for a stereo channel", () => {
    expect(localMicName(channel("abc", "USB Audio", 0).source, "")).toBe(
      "USB Audio · Left",
    );
    expect(localMicName(channel("abc", "USB Audio", 1).source, "")).toBe(
      "USB Audio · Right",
    );
  });

  it("defaults to the plain label for a mono device", () => {
    expect(localMicName(channel("abc", "Webcam Mic", 0, false).source, "")).toBe(
      "Webcam Mic",
    );
  });
});

describe("Mics-screen order in the This browser group", () => {
  it("sorts devices by name and channels by number", () => {
    const zoomRight = channel("z", "Zoom H1", 1);
    const zoomLeft = channel("z", "Zoom H1", 0);
    const usbRight = channel("u", "USB Audio", 1);
    const usbLeft = channel("u", "USB Audio", 0);
    const webcam = channel("w", "Webcam Mic", 0, false);
    expect(
      micsScreenOrder([zoomRight, webcam, usbRight, zoomLeft, usbLeft]).map(
        (c) => c.localMicId,
      ),
    ).toEqual([
      usbLeft.localMicId,
      usbRight.localMicId,
      webcam.localMicId,
      zoomLeft.localMicId,
      zoomRight.localMicId,
    ]);
  });
});

describe("which devices are open", () => {
  const dongle = channel("dongle", "USB Audio", 0);
  const dongleRight = channel("dongle", "USB Audio", 1);
  const webcam = channel("webcam", "Webcam Mic", 0, false);
  const devices = [
    { deviceId: "dongle", label: "USB Audio" },
    { deviceId: "webcam", label: "Webcam Mic" },
  ];

  it("is every device with a switched-on channel, while the Mics screen is closed", () => {
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices,
        kept: [kept(dongleRight, true), kept(webcam, false)],
        micsScreenOpen: false,
      }),
    ).toEqual(new Set(["dongle"]));
  });

  it("is none when nothing is switched on and the Mics screen is closed", () => {
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices,
        kept: [kept(dongle, false)],
        micsScreenOpen: false,
      }),
    ).toEqual(new Set());
  });

  it("leaves out a switched-on Local mic of another Stage browser or an absent device", () => {
    const elsewhere = browserChannels(
      "other-stage",
      { deviceId: "webcam", label: "Webcam Mic" },
      1,
    )[0] as BrowserChannel;
    const unplugged = channel("gone", "Old Mic", 0, false);
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices,
        kept: [kept(elsewhere, true), kept(unplugged, true)],
        micsScreenOpen: false,
      }),
    ).toEqual(new Set());
  });

  it("is every device while the Mics screen is open", () => {
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices,
        kept: [kept(dongle, true)],
        micsScreenOpen: true,
      }),
    ).toEqual(new Set(["dongle", "webcam"]));
  });
});

describe("the Stage browser's id", () => {
  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
  }

  it("is made once and kept", () => {
    const storage = memoryStorage();
    const first = stageBrowserId(storage, () => "made-1");
    const second = stageBrowserId(storage, () => "made-2");
    expect(first).toBe("made-1");
    expect(second).toBe("made-1");
  });
});
