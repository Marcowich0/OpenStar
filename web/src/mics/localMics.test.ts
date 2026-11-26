import { describe, expect, it } from "vitest";

import type { LocalMic } from "../generated/LocalMic";
import type { BridgeInterface } from "../generated/BridgeInterface";
import type { MicBridge } from "../generated/MicBridge";
import {
  bridgeGroupChannels,
  bridgeGroupNotes,
  matchBridgeLocalMics,
  browserChannels,
  browserInputDevices,
  devicesToOpen,
  presentLocalMics,
  localMicName,
  matchLocalMics,
  micsScreenOrder,
  stageBrowserId,
  type BridgeSource,
  type BrowserChannel,
  type LocalMicChannel,
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

describe("which of this browser's Local mics are present", () => {
  const left = channel("dongle", "USB Audio", 0);
  const right = channel("dongle", "USB Audio", 1);
  const mono = channel("webcam", "Webcam", 1);

  it("are those whose device is listed, as long as the device has that channel", () => {
    expect(
      presentLocalMics({
        stageBrowser: "stage",
        devices: [device("dongle", "USB Audio"), device("webcam", "Webcam")],
        // The webcam opened with one channel: it has no channel 1.
        open: new Map([
          ["dongle", 2],
          ["webcam", 1],
        ]),
        kept: [kept(left, true), kept(right, false), kept(mono, true)],
      }),
    ).toEqual([left.localMicId, right.localMicId]);
  });

  it("are none of an unplugged device or of another Stage browser", () => {
    const elsewhere = {
      ...kept(left, true),
      localMicId: "browser:other:dongle:0",
      source: { ...left.source, stageBrowser: "other" },
    };
    expect(
      presentLocalMics({
        stageBrowser: "stage",
        devices: [device("webcam", "Webcam")],
        open: new Map(),
        kept: [kept(left, true)],
      }),
    ).toEqual([]);
    expect(
      presentLocalMics({
        stageBrowser: "stage",
        devices: [device("dongle", "USB Audio")],
        open: new Map([["dongle", 2]]),
        kept: [elsewhere],
      }),
    ).toEqual([]);
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

function bridgeSource(
  bridgeId: string,
  label: string,
  channelNumber: number,
): BridgeSource {
  return {
    kind: "bridge",
    bridgeId,
    deviceName: `alsa_card.${label}`,
    label,
    channel: channelNumber,
  };
}

function bridgeChannel(
  bridgeId: string,
  label: string,
  channelNumber: number,
): LocalMicChannel {
  return {
    localMicId: `bridge:${bridgeId}:alsa_card.${label}:${String(channelNumber)}`,
    source: bridgeSource(bridgeId, label, channelNumber),
  };
}

function bridge(
  bridgeId: string,
  open: boolean,
  channels: LocalMicChannel[] = [],
): MicBridge {
  return { bridgeId, hostName: bridgeId, open, channels, interfaces: [] };
}

function loopbackChannel(
  bridgeId: string,
  label: string,
  channelNumber: number,
  loopback: number,
): LocalMicChannel {
  const made = bridgeChannel(bridgeId, label, channelNumber);
  return {
    ...made,
    source: { ...bridgeSource(bridgeId, label, channelNumber), loopback },
  };
}

function iface(
  label: string,
  more: Partial<BridgeInterface> = {},
): BridgeInterface {
  return {
    deviceName: `alsa_card.${label}`,
    label,
    channels: 4,
    twin: false,
    ...more,
  };
}

describe("a bridge Local mic", () => {
  it("defaults to '<device> · Input n', n counted from 1", () => {
    expect(localMicName(bridgeSource("b", "Scarlett 4i4", 0), "")).toBe(
      "Scarlett 4i4 · Input 1",
    );
    expect(localMicName(bridgeSource("b", "Scarlett 4i4", 3), "")).toBe(
      "Scarlett 4i4 · Input 4",
    );
  });

  it("shows the host's name when one is stored", () => {
    expect(localMicName(bridgeSource("b", "Scarlett 4i4", 0), "Red mic")).toBe(
      "Red mic",
    );
  });

  it("never opens a device of the Stage browser", () => {
    const fromBridge = bridgeChannel("b", "USB Audio", 0);
    expect(
      devicesToOpen({
        stageBrowser: "stage",
        devices: [{ deviceId: "dongle", label: "USB Audio" }],
        kept: [{ ...fromBridge, name: "", switchedOn: true }],
        micsScreenOpen: false,
      }),
    ).toEqual(new Set());
  });

  it("is never re-keyed to a browser channel nor shown as not found", () => {
    const fromBridge = bridgeChannel("b", "USB Audio", 0);
    const dongle = { deviceId: "dongle", label: "USB Audio" };
    const match = matchLocalMics({
      stageBrowser: "stage",
      devices: [dongle],
      open: new Map([["dongle", 1]]),
      kept: [{ ...fromBridge, name: "Red mic", switchedOn: true }],
    });
    expect(match.rekeys).toEqual([]);
    expect(match.notFound).toEqual([]);
    expect(match.newChannels).toEqual([
      channel("dongle", "USB Audio", 0, false),
    ]);
  });
});

describe("a bridge group's channels", () => {
  it("are an open bridge's channels, devices by name and channels by number", () => {
    const channels = [
      bridgeChannel("b", "UMC404HD", 1),
      bridgeChannel("b", "Scarlett", 1),
      bridgeChannel("b", "UMC404HD", 0),
      bridgeChannel("b", "Scarlett", 0),
    ];
    expect(
      bridgeGroupChannels(bridge("b", true, channels), []).map(
        (c) => c.localMicId,
      ),
    ).toEqual([
      "bridge:b:alsa_card.Scarlett:0",
      "bridge:b:alsa_card.Scarlett:1",
      "bridge:b:alsa_card.UMC404HD:0",
      "bridge:b:alsa_card.UMC404HD:1",
    ]);
  });

  it("are a closed bridge's kept Local mics, and no other bridge's or browser's", () => {
    const own = bridgeChannel("b", "Scarlett", 2);
    const other = bridgeChannel("c", "Scarlett", 0);
    const browser = channel("dongle", "USB Audio", 0);
    const keptMics = [own, other, browser].map((c) => ({
      ...c,
      name: "",
      switchedOn: true,
    }));
    expect(
      bridgeGroupChannels(bridge("b", false), keptMics).map(
        (c) => c.localMicId,
      ),
    ).toEqual([own.localMicId]);
  });
});

describe("loopback channels of the known-models table", () => {
  it("are named '<device> · Loopback n'", () => {
    const [first, second] = [
      loopbackChannel("b", "Scarlett 4i4 4th Gen", 4, 1),
      loopbackChannel("b", "Scarlett 4i4 4th Gen", 5, 2),
    ];
    expect(localMicName(first.source, "")).toBe(
      "Scarlett 4i4 4th Gen · Loopback 1",
    );
    expect(localMicName(second.source, "")).toBe(
      "Scarlett 4i4 4th Gen · Loopback 2",
    );
    expect(localMicName(first.source, "Song")).toBe("Song");
  });

  it("go last in their bridge's group, after every device's inputs", () => {
    const channels = [
      loopbackChannel("b", "Scarlett", 5, 2),
      bridgeChannel("b", "UMC404HD", 0),
      loopbackChannel("b", "Scarlett", 4, 1),
      bridgeChannel("b", "Scarlett", 0),
    ];
    expect(
      bridgeGroupChannels(bridge("b", true, channels), []).map(
        (c) => c.localMicId,
      ),
    ).toEqual([
      "bridge:b:alsa_card.Scarlett:0",
      "bridge:b:alsa_card.UMC404HD:0",
      "bridge:b:alsa_card.Scarlett:4",
      "bridge:b:alsa_card.Scarlett:5",
    ]);
  });
});

describe("a bridge group's notes", () => {
  it("say that swapping their USB ports swaps their mics when twins are present", () => {
    const open = {
      ...bridge("b", true),
      interfaces: [
        iface("UMC404HD 192k", { twin: true, deviceName: "u@1" }),
        iface("UMC404HD 192k", { twin: true, deviceName: "u@2" }),
      ],
    };
    expect(bridgeGroupNotes(open, []).twins).toBe(true);
    expect(
      bridgeGroupNotes({ ...open, interfaces: [iface("Scarlett")] }, []).twins,
    ).toBe(false);
  });

  it("say 'use one or the other' when This browser reads the same interface", () => {
    const open = {
      ...bridge("b", true, [bridgeChannel("b", "Scarlett 4i4 4th Gen", 0)]),
      interfaces: [iface("Scarlett 4i4 4th Gen")],
    };
    const browserScarlett = {
      deviceId: "d1",
      label: "Scarlett 4i4 4th Gen Pro",
    };
    expect(bridgeGroupNotes(open, [browserScarlett]).sameInterface).toBe(true);
    expect(
      bridgeGroupNotes(open, [{ deviceId: "d2", label: "USB Audio" }])
        .sameInterface,
    ).toBe(false);
    // A label that merely starts the same way is another device.
    expect(
      bridgeGroupNotes(open, [
        { deviceId: "d3", label: "Scarlett 4i4 4th Generation" },
      ]).sameInterface,
    ).toBe(false);
  });
});

describe("a bridge's Local mics that are not found", () => {
  it("are the kept ones an open bridge no longer offers, with its new channels to pick", () => {
    const moved = bridgeChannel("b", "UMC404HD@port1", 0);
    const stays = bridgeChannel("b", "UMC404HD@port2", 0);
    const now = bridgeChannel("b", "UMC404HD@port3", 0);
    const kept = [moved, stays].map((c) => ({
      ...c,
      name: "Red mic",
      switchedOn: true,
    }));
    const match = matchBridgeLocalMics(bridge("b", true, [stays, now]), kept);
    expect(match.notFound.map((m) => m.localMicId)).toEqual([moved.localMicId]);
    expect(match.newChannels).toEqual([now]);
  });

  it("are none for a closed bridge: its Local mics show as closed", () => {
    const keptMic = {
      ...bridgeChannel("b", "Scarlett", 0),
      name: "",
      switchedOn: true,
    };
    expect(matchBridgeLocalMics(bridge("b", false), [keptMic])).toEqual({
      notFound: [],
      newChannels: [],
    });
  });
});
