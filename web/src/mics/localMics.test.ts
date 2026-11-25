import { describe, expect, it } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import {
  browserChannels,
  browserInputDevices,
  devicesToOpen,
  localMicName,
  matchLocalMics,
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
    const channels = browserChannels("s", { deviceId: "abc", label: "Mic" }, 1);
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
    expect(
      localMicName(channel("abc", "Webcam Mic", 0, false).source, ""),
    ).toBe("Webcam Mic");
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

describe("id matching on the browser path", () => {
  // The dongle as it was kept, and as Chromium lists it again with a new
  // deviceId (a reload, cleared site data, a renamed source).
  const keptLeft = channel("dongle-old", "USB Audio", 0);
  const keptRight = channel("dongle-old", "USB Audio", 1);
  const newLeft = channel("dongle-new", "USB Audio", 0);
  const newRight = channel("dongle-new", "USB Audio", 1);
  const dongleNew = { deviceId: "dongle-new", label: "USB Audio" };
  const twin = { deviceId: "twin", label: "USB Audio" };

  it("finds a Local mic by its stored deviceId", () => {
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [{ deviceId: "dongle-old", label: "USB Audio" }],
      open: new Map([["dongle-old", 2]]),
      kept: [kept(keptLeft, true, "Red mic")],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([]);
    expect(match.newChannels).toEqual([keptRight]);
  });

  it("re-keys a Local mic whose id is gone to the one channel with the same exact label and channel", () => {
    const red = kept(keptRight, true, "Red mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew],
      open: new Map([["dongle-new", 2]]),
      kept: [red],
    });
    expect(match.rekeys).toEqual([{ localMic: red, channel: newRight }]);
    expect(match.notFound).toEqual([]);
    expect(match.newChannels).toEqual([newLeft]);
  });

  it("matches nothing when two channels fit, so the Local mic is not found", () => {
    const red = kept(keptLeft, true, "Red mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew, twin],
      open: new Map([
        ["dongle-new", 2],
        ["twin", 2],
      ]),
      kept: [red],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([red]);
    expect(match.newChannels.map((c) => c.localMicId)).toEqual([
      newLeft.localMicId,
      newRight.localMicId,
      channel("twin", "USB Audio", 0).localMicId,
      channel("twin", "USB Audio", 1).localMicId,
    ]);
  });

  it("matches nothing when two missing Local mics fit the same channel", () => {
    const red = kept(keptLeft, true, "Red mic");
    const blue = kept(channel("other-old", "USB Audio", 0), true, "Blue mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew],
      open: new Map([["dongle-new", 2]]),
      kept: [red, blue],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([red, blue]);
  });

  it("attempts no fuzzy label match: a changed label is not found", () => {
    const red = kept(keptLeft, true, "Red mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [{ deviceId: "dongle-pro", label: "USB Audio Pro" }],
      open: new Map([["dongle-pro", 2]]),
      kept: [red],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([red]);
  });

  it("never re-keys to a channel that is already a Local mic", () => {
    const red = kept(keptLeft, true, "Red mic");
    const taken = kept(newLeft, false);
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew],
      open: new Map([["dongle-new", 2]]),
      kept: [red, taken],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([red]);
    expect(match.newChannels).toEqual([newRight]);
  });

  it("waits until every device with that label is open before it decides", () => {
    const red = kept(keptLeft, true, "Red mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew, twin],
      open: new Map([["dongle-new", 2]]),
      kept: [red],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([red]);
  });

  it("re-keys only this Stage browser's Local mics, and shows another's as not found", () => {
    const elsewhere = kept(
      browserChannels(
        "other-stage",
        { deviceId: "x", label: "USB Audio" },
        2,
      )[0] as BrowserChannel,
      true,
      "Their mic",
    );
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongleNew],
      open: new Map([["dongle-new", 2]]),
      kept: [elsewhere],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([elsewhere]);
    expect(match.newChannels).toEqual([newLeft, newRight]);
  });

  it("does not call a kept Local mic of a present but closed device not found", () => {
    const red = kept(keptLeft, false, "Red mic");
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [{ deviceId: "dongle-old", label: "USB Audio" }],
      open: new Map(),
      kept: [red],
    });
    expect(match.notFound).toEqual([]);
    expect(match.newChannels).toEqual([]);
  });
});

describe("which devices are open, for a missing Local mic", () => {
  it("includes every device with the label of a missing switched-on Local mic of this browser, so it can be re-keyed", () => {
    const missing = channel("dongle-old", "USB Audio", 0);
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices: [
          { deviceId: "dongle-new", label: "USB Audio" },
          { deviceId: "webcam", label: "Webcam Mic" },
        ],
        kept: [kept(missing, true)],
        micsScreenOpen: false,
      }),
    ).toEqual(new Set(["dongle-new"]));
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
