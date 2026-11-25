import { describe, expect, it } from "vitest";

import { dbToGain, OPENSTAR_VOLUME, songGainDb, volumeGain } from "./gain";

describe("Song gain", () => {
  it.each([
    [-24, 6],
    [-30, 6],
    [-10, -8],
    [-18, 0],
  ])("a Song measured at %d LUFS plays at %d dB", (lufs, db) => {
    expect(songGainDb(lufs)).toBeCloseTo(db, 9);
  });

  it("plays a Song that is not measured yet at unity (0 dB)", () => {
    expect(songGainDb(null)).toBe(0);
  });

  it("turns decibels into a linear gain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.9953, 4);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 9);
  });
});

describe("OpenStar volume", () => {
  it.each([
    [80, 0.64],
    [0, 0],
    [100, 1],
    [50, 0.25],
  ])("volume %d is gain %d", (volume, gain) => {
    expect(volumeGain(volume)).toBeCloseTo(gain, 9);
  });

  it("starts at 80", () => {
    expect(OPENSTAR_VOLUME.default).toBe(80);
  });
});
