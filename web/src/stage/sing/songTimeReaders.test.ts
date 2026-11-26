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
    // And in the playback view's readout (#155, kept as a debug page), and in
    // the live scoring session (#165), which finalises Beats on Song time
    // itself: drawing runs behind by the A/V offset, scoring never does.
    // The playback adapter reads it only at its event-only position reports
    // for the Remotes (#159): start, pause, resume, Restart and end.
    expect(filesMatching(/\.songTime\s*\(/)).toEqual([
      "src/playback/mediaPlayback.ts",
      "src/scoring/liveScoring.ts",
      "src/stage/playback/PlaybackCheck.tsx",
      "src/stage/sing/renderLoop.ts",
    ]);
  });

  it("reads the media element's position nowhere but in the Song clock's observations", () => {
    // `currentTime` and `mediaTime` reach the clock as observations from the
    // playback adapter, the one owner of the media element (#155). The
    // song-browser preview (#162) seeks its own element, never the Song's,
    // to the preview point and schedules its fades on the AudioContext's
    // `currentTime`; it feeds no clock. The Calibration tone run (#156) reads
    // its AudioContext's `currentTime` only to schedule tones; their play
    // times come from `outputTime`. So does the Check A/V sync click
    // (#163) for its clicks and their landing times.
    expect(
      filesMatching(
        /\.currentTime\b|\.mediaTime\b|requestVideoFrameCallback\s*\(/,
      ),
    ).toEqual([
      "src/avSync/clickTrack.ts",
      "src/calibration/toneRun.ts",
      "src/clock/songClock.ts",
      "src/playback/mediaPlayback.ts",
      "src/playback/songPreview.ts",
    ]);
  });

  it("never hands Song time or progress to a Phone's mic path", () => {
    // The Pitch capture and relay (and the Phone's mic) send readings only;
    // the Remote's progress lives in the live state, away from them.
    const micPath = /^\/src\/(pitch|phone\/mic)\//;
    const offenders = Object.entries(sources)
      .filter(([path]) => micPath.test(path))
      .filter(([, text]) =>
        /songProgress|SongProgress|progressAt|\.songTime\s*\(/.test(text),
      )
      .map(([path]) => path);
    expect(
      Object.keys(sources).filter((path) => micPath.test(path)).length,
    ).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("reads the A/V offset only to draw, never for readings, Beats, scoring or the video", () => {
    // The getter is called only where the drawing time is computed (the
    // render loop, through the sing screen that hands it on).
    expect(filesMatching(/\bavOffset\s*\(\s*\)/)).toEqual([
      "src/stage/sing/SingScreen.tsx",
      "src/stage/sing/renderLoop.ts",
    ]);
    // The kept value is loaded only to be handed to that getter, and by
    // Check A/V sync (#163), which shows and steps it and draws its own
    // test pattern with it, never Song time.
    expect(filesMatching(/from "[^"]*\/(avOffset|use\w*AvOffset)"/)).toEqual([
      "src/avOffset/useAvOffset.ts",
      "src/avSync/AvSyncPanel.tsx",
      "src/avSync/StageAvSync.tsx",
      "src/avSync/avSyncStep.ts",
      "src/stage/output/useStageAvOffset.ts",
      "src/stage/scenes/sing/SingScene.tsx",
    ]);
    // No code (comments aside) of the Pitch readings, the Song clock and
    // Beats, the scorer, the media playback or the video names it.
    const kept =
      /^\/src\/(pitch|clock|scoring|playback|phone\/mic)\/|\/SingBackdrop\.tsx$/;
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const offenders = Object.entries(sources)
      .filter(([path]) => kept.test(path))
      .filter(([, text]) => /avOffset|AvOffset|\bAV_OFFSET\b/.test(code(text)))
      .map(([path]) => path);
    expect(
      Object.keys(sources).filter((path) => kept.test(path)).length,
    ).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
