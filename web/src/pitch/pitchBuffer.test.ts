import { describe, expect, it } from "vitest";

import type { PitchReading } from "../generated/PitchReading";
import { PitchBuffer } from "./pitchBuffer";

function reading(captureMs: number, pitch: number | null = 60): PitchReading {
  return { captureMs, pitch, clarity: 0.9, loudness: -20 };
}

/** Everything the buffer visits from `from`, as plain rows. */
function visited(buffer: PitchBuffer, from: number) {
  const rows: [number, number | null, number, number, number][] = [];
  buffer.forEachFrom(from, (songTime, pitch, clarity, loudness, captureMs) => {
    rows.push([songTime, pitch, clarity, loudness, captureMs]);
  });
  return rows;
}

describe("Pitch reading ring buffer", () => {
  it("starts empty", () => {
    const buffer = new PitchBuffer(4);
    expect(buffer.capacity).toBe(4);
    expect(buffer.size).toBe(0);
    expect(visited(buffer, 0)).toEqual([]);
  });

  it("visits every field of a reading as it was pushed", () => {
    const buffer = new PitchBuffer(4);
    buffer.push(
      { captureMs: 1234.5, pitch: 61.25, clarity: 0.8, loudness: -33 },
      2.5,
    );
    expect(visited(buffer, 0)).toEqual([[2.5, 61.25, 0.8, -33, 1234.5]]);
  });

  it("keeps an unvoiced reading's missing pitch", () => {
    const buffer = new PitchBuffer(4);
    buffer.push(reading(10, null), 1);
    expect(visited(buffer, 0)).toEqual([[1, null, 0.9, -20, 10]]);
  });

  it("overwrites the oldest readings once it is full", () => {
    const buffer = new PitchBuffer(3);
    for (let i = 0; i < 7; i++) buffer.push(reading(i * 10), i);
    expect(buffer.size).toBe(3);
    expect(visited(buffer, 0).map((row) => row[0])).toEqual([4, 5, 6]);
  });

  it("visits readings from a Song time on, in arrival order", () => {
    const buffer = new PitchBuffer(5);
    for (let i = 0; i < 12; i++) buffer.push(reading(i * 10), i * 0.01);
    // Holds 0.07 … 0.11; from 0.09 on is 0.09, 0.10, 0.11.
    expect(visited(buffer, 0.09).map((row) => row[4])).toEqual([90, 100, 110]);
    expect(visited(buffer, 0).map((row) => row[4])).toEqual([
      70, 80, 90, 100, 110,
    ]);
    expect(visited(buffer, 1)).toEqual([]);
  });

  it("visits a reading exactly at the given Song time", () => {
    const buffer = new PitchBuffer(4);
    buffer.push(reading(0), 1);
    buffer.push(reading(10), 2);
    expect(visited(buffer, 2).map((row) => row[0])).toEqual([2]);
  });

  it("gives the newest arrived reading and its pitch", () => {
    const buffer = new PitchBuffer(2);
    expect(buffer.newestSongTime()).toBeNull();
    expect(buffer.newestPitch()).toBeNull();
    buffer.push(reading(0, 60), 1);
    buffer.push(reading(10, 62.5), 2);
    buffer.push(reading(20, 64), 3);
    expect(buffer.newestSongTime()).toBe(3);
    expect(buffer.newestPitch()).toBe(64);
    expect(visited(buffer, 0).length).toBe(2);
    buffer.push(reading(30, null), 4);
    expect(buffer.newestSongTime()).toBe(4);
    expect(buffer.newestPitch()).toBeNull();
  });

  it("visits the newest reading in place", () => {
    const buffer = new PitchBuffer(2);
    const rows: number[] = [];
    expect(buffer.visitNewest((songTime) => rows.push(songTime))).toBe(false);
    buffer.push(reading(10, 60), 1);
    buffer.push(reading(20, 61), 2);
    expect(buffer.visitNewest((songTime) => rows.push(songTime))).toBe(true);
    expect(rows).toEqual([2]);
  });

  it("forgets everything when cleared, keeping its capacity", () => {
    const buffer = new PitchBuffer(3);
    buffer.push(reading(0), 5);
    buffer.push(reading(10), 6);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.newestSongTime()).toBeNull();
    buffer.push(reading(20), 1);
    expect(visited(buffer, 0).map((row) => row[0])).toEqual([1]);
    expect(buffer.capacity).toBe(3);
  });

  it("refuses a capacity below one", () => {
    expect(() => new PitchBuffer(0)).toThrow(RangeError);
    expect(() => new PitchBuffer(2.5)).toThrow(RangeError);
  });
});
