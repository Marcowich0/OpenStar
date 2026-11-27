import { describe, expect, it } from "vitest";

import {
  parseReferenceCsv,
  parseWav,
  rawPitchAccuracy,
  type TimedPitch,
} from "./pitchAccuracy";

/** A 16-bit mono PCM WAV of `samples`, with an extra chunk before `data`. */
function wav(samples: number[], sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + 12 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "LIST");
  view.setUint32(40, 4, true);
  text(44, "INFO");
  text(48, "data");
  view.setUint32(52, samples.length * 2, true);
  samples.forEach((s, i) => {
    view.setInt16(56 + i * 2, s, true);
  });
  return bytes;
}

describe("parseWav", () => {
  it("reads 16-bit mono PCM as floats in [−1, 1), skipping other chunks", () => {
    const { sampleRate, samples } = parseWav(
      wav([0, 16_384, -32_768, 32_767], 44_100),
    );
    expect(sampleRate).toBe(44_100);
    expect(Array.from(samples)).toEqual([0, 0.5, -1, 32_767 / 32_768]);
  });

  it("refuses anything but 16-bit mono PCM", () => {
    const stereo = wav([0, 0], 44_100);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow(/mono/);
    expect(() => parseWav(new Uint8Array(12))).toThrow(/WAV/);
  });
});

describe("parseReferenceCsv", () => {
  it("reads time and f0 rows, 0 Hz as unvoiced", () => {
    expect(parseReferenceCsv("0.0,0.0\n0.0058,220.5\n")).toEqual([
      { timeS: 0, hz: 0 },
      { timeS: 0.0058, hz: 220.5 },
    ]);
  });
});

describe("rawPitchAccuracy", () => {
  /** Readings every 10 ms from 0 s, all at `pitch`. */
  const readings = (pitch: number | null, count = 11): TimedPitch[] =>
    Array.from({ length: count }, (_, i) => ({ timeS: i / 100, pitch }));

  it("counts only voiced reference frames", () => {
    const result = rawPitchAccuracy(
      [
        { timeS: 0.02, hz: 440 },
        { timeS: 0.03, hz: 0 },
        { timeS: 0.04, hz: 440 },
      ],
      readings(69),
    );
    expect(result).toEqual({ voicedFrames: 2, hits: 2 });
  });

  it("folds the detector's pitch to the reference's octave", () => {
    const reference = [{ timeS: 0.05, hz: 220 }];
    expect(rawPitchAccuracy(reference, readings(69)).hits).toBe(1);
    expect(rawPitchAccuracy(reference, readings(69 + 24)).hits).toBe(1);
    // A fifth off is a miss, in any octave.
    expect(rawPitchAccuracy(reference, readings(64)).hits).toBe(0);
  });

  it("hits within 50 cents and misses beyond", () => {
    const reference = [{ timeS: 0.05, hz: 440 }];
    expect(rawPitchAccuracy(reference, readings(69.49)).hits).toBe(1);
    expect(rawPitchAccuracy(reference, readings(68.51)).hits).toBe(1);
    expect(rawPitchAccuracy(reference, readings(69.51)).hits).toBe(0);
    expect(rawPitchAccuracy(reference, readings(68.49)).hits).toBe(0);
  });

  it("counts an unvoiced reading on a voiced frame as a miss", () => {
    expect(
      rawPitchAccuracy([{ timeS: 0.05, hz: 440 }], readings(null)),
    ).toEqual({ voicedFrames: 1, hits: 0 });
  });

  it("judges each reference frame by the reading nearest in time", () => {
    const mixed: TimedPitch[] = [
      { timeS: 0, pitch: 69 },
      { timeS: 0.01, pitch: 69 },
      { timeS: 0.02, pitch: 60 },
    ];
    const reference = [0.004, 0.006, 0.014, 0.016, 0.03].map((timeS) => ({
      timeS,
      hz: 440,
    }));
    expect(rawPitchAccuracy(reference, mixed)).toEqual({
      voicedFrames: 5,
      hits: 3,
    });
  });
});
