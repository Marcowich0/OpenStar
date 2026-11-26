import { describe, expect, it, vi } from "vitest";

import type { MicKey } from "../generated/MicKey";
import { createStageMicSettings, seatMicSettings } from "./stageMicSettings";

const PHONE: MicKey = { kind: "phone", phoneId: "phone-mia" };
const RED: MicKey = { kind: "localMic", localMicId: "red" };

describe("the Mic settings of the Stage's current output", () => {
  it("knows nothing before a Stage output's values are loaded: every Mic sings on the defaults", () => {
    const settings = createStageMicSettings();
    expect(settings.storedFor(PHONE)).toBeUndefined();
    expect(seatMicSettings(PHONE, settings.storedFor(PHONE), 80)).toEqual({
      micDelayMs: 100,
      effectiveThresholdDbfs: -30,
      calibrated: false,
      thresholdSource: "default",
    });
    expect(seatMicSettings(RED, settings.storedFor(RED), 80)).toEqual({
      micDelayMs: 0,
      effectiveThresholdDbfs: -40,
      calibrated: false,
      thresholdSource: "default",
    });
  });

  it("gives each Mic the values stored for it at the loaded output, and forgets them when none are loaded", () => {
    const settings = createStageMicSettings();
    const listener = vi.fn();
    settings.subscribe(listener);
    settings.set({
      stageOutput: "Speakers",
      mics: [
        {
          mic: { kind: "phone", phoneId: "phone-mia" },
          settings: { calibration: { micDelayMs: 240, bleedLevelDbfs: -50 } },
        },
        {
          mic: { kind: "localMic", localMicId: "red" },
          settings: {
            micThreshold: { referenceDbfs: -35, setBy: "hand" },
          },
        },
      ],
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(seatMicSettings(PHONE, settings.storedFor(PHONE), 80)).toEqual({
      micDelayMs: 240,
      effectiveThresholdDbfs: -44,
      calibrated: true,
      thresholdSource: "calibration",
    });
    expect(
      seatMicSettings(RED, settings.storedFor(RED), 80).effectiveThresholdDbfs,
    ).toBe(-35);
    // A Mic nothing is stored for, at the same output.
    expect(
      settings.storedFor({ kind: "phone", phoneId: "phone-leo" }),
    ).toBeUndefined();

    settings.set(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(settings.storedFor(PHONE)).toBeUndefined();
  });

  it("moves the threshold with the OpenStar volume: 40·log10(volume / 80) dB", () => {
    expect(
      seatMicSettings(PHONE, undefined, 40).effectiveThresholdDbfs,
    ).toBeCloseTo(-30 + 40 * Math.log10(40 / 80));
    expect(
      seatMicSettings(RED, undefined, 100).effectiveThresholdDbfs,
    ).toBeCloseTo(-40 + 40 * Math.log10(100 / 80));
  });

  it("treats a seat without a Mic as an uncalibrated Phone", () => {
    expect(seatMicSettings(null, undefined, 80).effectiveThresholdDbfs).toBe(
      -30,
    );
  });
});
