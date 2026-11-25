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
    expect(filesMatching(/\.songTime\s*\(/)).toEqual([
      "src/stage/sing/renderLoop.ts",
    ]);
  });

  it("reads the media element's position nowhere but in the Song clock's observations", () => {
    // `currentTime` and `mediaTime` reach the clock as observations; the media
    // owner (#53) that samples the element is to be added here when it lands.
    expect(
      filesMatching(
        /\.currentTime\b|\.mediaTime\b|requestVideoFrameCallback\s*\(/,
      ),
    ).toEqual(["src/clock/songClock.ts"]);
  });
});
