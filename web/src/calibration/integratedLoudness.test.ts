import { describe, expect, it } from "vitest";

import { integratedLoudness } from "./integratedLoudness";

const RATE = 48_000;

function sine(hz: number, amplitude: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return samples;
}

describe("EBU R128 integrated loudness", () => {
  it("reads the Library's reference tone as ffmpeg's ebur128 does", () => {
    // ffmpeg reads 1 kHz at amplitude 1/8, mono, as −21.07 LUFS (#145).
    expect(integratedLoudness(sine(1000, 1 / 8, 5), RATE)).toBeCloseTo(
      -21.07,
      1,
    );
  });

  it("reads a 1 kHz sine's mean square: amplitude 0.1 is −23.01 LUFS", () => {
    // K-weighting is +0.69 dB at 1 kHz, cancelling R128's −0.691 offset, so
    // the reading is 10·log10(0.1² / 2).
    expect(integratedLoudness(sine(1000, 0.1, 20), RATE)).toBeCloseTo(
      -23.01,
      1,
    );
  });

  it("leaves silence out through the absolute gate, as ffmpeg does", () => {
    // ffmpeg: 5 s silence, this tone, 10 s silence reads −21.3 LUFS (the
    // blocks overlapping the tone's edges pass the gates).
    const tone = sine(1000, 1 / 8, 5);
    const padded = new Float32Array(tone.length + 10 * RATE);
    padded.set(tone, 5 * RATE);
    expect(integratedLoudness(padded, RATE)).toBeCloseTo(-21.3, 1);
  });

  it("leaves out what is more than 10 LU under the rest (relative gate)", () => {
    const loud = sine(1000, 1 / 8, 5);
    const quiet = sine(1000, 1 / 80, 5);
    const both = new Float32Array(loud.length + quiet.length);
    both.set(loud);
    both.set(quiet, loud.length);
    // ffmpeg reads −21.2 LUFS; ungated, the quiet half would make it −24.
    expect(integratedLoudness(both, RATE)).toBeCloseTo(-21.2, 1);
  });
});
