import { describe, expect, it } from "vitest";

// Every non-test source file in the frontend, as text.
const sources = import.meta.glob<string>(
  [
    "/src/**/*.{ts,tsx}",
    "!/src/**/*.test.{ts,tsx}",
    "!/src/**/*.typetest.{ts,tsx}",
    "!/src/generated/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

function filesMatching(pattern: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path.slice(1))
    .sort();
}

describe("who reads the Song's position", () => {
  it("scans the frontend's sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("reads songTime() only in the render loop", () => {
    // And in the playback view's readout (#155), until the sing scene plays
    // Songs (#164).
    expect(filesMatching(/\.songTime\s*\(/)).toEqual([
      "src/stage/playback/PlaybackCheck.tsx",
      "src/stage/sing/renderLoop.ts",
    ]);
  });

  it("reads the media element's position nowhere but in the Song clock's observations", () => {
    // `currentTime` and `mediaTime` reach the clock as observations from the
    // playback adapter, the one owner of the media element (#155). The
    // song-browser preview (#162) seeks its own element, never the Song's,
    // to the preview point and schedules its fades on the AudioContext's
    // `currentTime`; it feeds no clock.
    expect(
      filesMatching(
        /\.currentTime\b|\.mediaTime\b|requestVideoFrameCallback\s*\(/,
      ),
    ).toEqual([
      "src/clock/songClock.ts",
      "src/playback/mediaPlayback.ts",
      "src/playback/songPreview.ts",
    ]);
  });
});
