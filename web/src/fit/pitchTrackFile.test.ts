import { afterEach, describe, expect, it, vi } from "vitest";

import fixtureText from "../../../fixtures/pitch-track/frames.json?raw";
import { ApiFailure } from "../api/api";
import { createMatcher } from "./fit";
import { downloadPitchTrack, readPitchTrack } from "./pitchTrackFile";

interface Fixture {
  frameSeconds: number;
  frames: [number, number, number][];
  bytes: string;
}

const fixture = JSON.parse(fixtureText) as Fixture;

/** The fixture's bytes, as the Rust writer produces them. */
function rustWritten(): ArrayBuffer {
  const hex = fixture.bytes;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading a downloaded Pitch track", () => {
  it("decodes Rust-written frames into pitch, clarity and envelope", () => {
    const track = readPitchTrack(rustWritten());

    expect(track.frameSeconds).toBe(fixture.frameSeconds);
    expect(Array.from(track.pitch)).toEqual(
      fixture.frames.map((f) => Math.fround(f[0])),
    );
    expect(Array.from(track.clarity)).toEqual(
      fixture.frames.map((f) => Math.fround(f[1])),
    );
    expect(Array.from(track.envelope)).toEqual(
      fixture.frames.map((f) => Math.fround(f[2])),
    );
  });

  it("gives the fit module a track it takes as it is", () => {
    expect(() => createMatcher(readPitchTrack(rustWritten()))).not.toThrow();
  });

  it("refuses bytes that are not whole frames", () => {
    expect(() => readPitchTrack(new ArrayBuffer(13))).toThrow(/12-byte/);
    expect(readPitchTrack(new ArrayBuffer(0)).pitch).toHaveLength(0);
  });

  it("downloads the Song's track as one response", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(rustWritten(), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const track = await downloadPitchTrack(7);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/songs/7/pitch-track");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(track.pitch[2]).toBe(440.5);
  });

  it("rejects when no current track is cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );

    const error: unknown = await downloadPitchTrack(7).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).failure).toEqual({
      kind: "unexpected",
      status: 404,
    });
  });
});
