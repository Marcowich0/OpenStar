import { describe, expect, it } from "vitest";

import type { PartyLocalMic } from "../generated/PartyLocalMic";
import type { Seat } from "../generated/Seat";
import {
  LEO_SEAT,
  MIA_SEAT,
  testLineUp,
  testParty,
} from "../stage/scenes/sing/testSong";
import { browserChannels, type BrowserChannel } from "./localMics";
import { detectingChannels, detectingLocalMics } from "./localMicPitch";

const DONGLE = { deviceId: "dongle", label: "USB Audio" };
const [left, right] = browserChannels("stage", DONGLE, 2) as [
  BrowserChannel,
  BrowserChannel,
];

const switchedOn = (channel: BrowserChannel): PartyLocalMic => ({
  localMicId: channel.localMicId,
  source: channel.source,
  name: "",
  present: true,
});

const seatOn = (channel: BrowserChannel): Seat => ({
  ...LEO_SEAT,
  mic: { kind: "localMic", localMicId: channel.localMicId },
});

const PLAYING = { requestId: 5, songId: 7, paused: false };

describe("which Local mics' detectors run", () => {
  it("the switched-on Local mics seated in the Song that plays", () => {
    const party = testParty({
      lineUp: testLineUp([MIA_SEAT, seatOn(right)]),
      playing: PLAYING,
      localMics: [switchedOn(left), switchedOn(right)],
    });
    expect([...detectingLocalMics(party)]).toEqual([right.localMicId]);
  });

  it("go on through a pause, so a paused Song's Mic is not lost", () => {
    const party = testParty({
      lineUp: testLineUp([seatOn(right)]),
      playing: { ...PLAYING, paused: true },
      localMics: [switchedOn(right)],
    });
    expect([...detectingLocalMics(party)]).toEqual([right.localMicId]);
  });

  it("none while the Line-up waits, the results show or there is no Party", () => {
    const seated = {
      lineUp: testLineUp([seatOn(right)]),
      localMics: [switchedOn(right)],
    };
    expect(detectingLocalMics(testParty(seated)).size).toBe(0);
    expect(
      detectingLocalMics(testParty({ ...seated, lineUp: null })).size,
    ).toBe(0);
    expect(detectingLocalMics(null).size).toBe(0);
  });

  it("not a seated Local mic that is switched off", () => {
    const party = testParty({
      lineUp: testLineUp([seatOn(right)]),
      playing: PLAYING,
      localMics: [switchedOn(left)],
    });
    expect(detectingLocalMics(party).size).toBe(0);
  });
});

describe("the channels to detect on", () => {
  it("are the open channels of this Stage browser whose Local mic detects", () => {
    expect(
      detectingChannels({
        stageBrowser: "stage",
        open: new Map([
          ["dongle", 2],
          ["webcam", 1],
        ]),
        detecting: new Set([right.localMicId, "browser:other:webcam:0"]),
      }),
    ).toEqual([{ deviceId: "dongle", channel: 1 }]);
  });
});
