import { describe, expect, it } from "vitest";

import type { PartyLocalMic } from "../generated/PartyLocalMic";
import { createSilentLocalMics, type ZeroSources } from "./silentLocalMics";

const browser = (id: string, present = true): PartyLocalMic => ({
  localMicId: id,
  name: "",
  present,
  source: {
    kind: "browser",
    stageBrowser: "stage-1",
    deviceId: `dev-${id}`,
    label: "USB",
    channel: 0,
    stereo: false,
  },
});

const bridge = (id: string, present = true): PartyLocalMic => ({
  localMicId: id,
  name: "",
  present,
  source: {
    kind: "bridge",
    bridgeId: "b",
    deviceName: "umc",
    label: "UMC",
    channel: 1,
  },
});

/** Sources where every listed Local mic reads `zero`. */
function sources(zero: Record<string, boolean | null>): ZeroSources {
  return {
    browser: (deviceId) => zero[deviceId.replace("dev-", "")] ?? null,
    bridge: (localMicId) => zero[localMicId] ?? null,
  };
}

describe("the silent Local mics the Stage reports", () => {
  it("are present switched-on ones in exact zeros for more than 2 s, on either path", () => {
    const silent = createSilentLocalMics();
    const mics = [browser("red"), bridge("b-1"), browser("blue")];
    const zeros = sources({ red: true, "b-1": true, blue: false });
    expect(silent.look(mics, zeros, 0)).toEqual([]);
    expect(silent.look(mics, zeros, 2000)).toEqual([]);
    expect(silent.look(mics, zeros, 2001)).toEqual(["b-1", "red"]);
  });

  it("leave out an unplugged one and start afresh when it is back", () => {
    const silent = createSilentLocalMics();
    const zeros = sources({ red: true });
    silent.look([browser("red")], zeros, 0);
    expect(silent.look([browser("red", false)], zeros, 2500)).toEqual([]);
    expect(silent.look([browser("red")], zeros, 3000)).toEqual([]);
    expect(silent.look([browser("red")], zeros, 5001)).toEqual(["red"]);
  });

  it("leave out one whose zeros are unknown (its device not open, its levels stale)", () => {
    const silent = createSilentLocalMics();
    silent.look([bridge("b-1")], sources({ "b-1": true }), 0);
    expect(silent.look([bridge("b-1")], sources({}), 2500)).toEqual([]);
  });

  it("leave out one no longer switched on", () => {
    const silent = createSilentLocalMics();
    silent.look([browser("red")], sources({ red: true }), 0);
    expect(silent.look([], sources({ red: true }), 2500)).toEqual([]);
  });
});
