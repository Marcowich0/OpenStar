import { describe, expect, it } from "vitest";

import { testDetail } from "../stage/scenes/sing/testSong";
import {
  firstNoteSeconds,
  INTRO_SKIP,
  introEnd,
  offersSkipIntro,
  secondsToSinging,
} from "./introSkip";

// The test Song: 240 Beats a minute (a Beat is 0.25 s), Notes from Beat 0.
function song(gapSeconds: number, duet = false) {
  return testDetail({ duet, headers: { gapSeconds } }).song;
}

describe("firstNoteSeconds", () => {
  it("is the earliest Note of the Voices sung", () => {
    expect(firstNoteSeconds(song(20), [0])).toBe(20);
    const duet = song(20, true);
    duet.voices[1]?.lines[0]?.notes.splice(0, 1);
    // P2's first Note is now its Beat 4, one second later.
    expect(firstNoteSeconds(duet, [1])).toBe(21);
    expect(firstNoteSeconds(duet, [0, 1])).toBe(20);
  });

  it("is null without Notes", () => {
    expect(firstNoteSeconds(song(20), [])).toBeNull();
    expect(firstNoteSeconds(song(20), [3])).toBeNull();
  });
});

describe("introEnd", () => {
  const input = (gapSeconds: number, startSeconds = 0) => ({
    song: song(gapSeconds),
    voices: [0],
    startSeconds,
    endSeconds: null,
  });

  it("lands a few seconds before the first Note", () => {
    expect(introEnd(input(42))).toBe(42 - INTRO_SKIP.leadInSeconds);
  });

  it("is null for an Intro shorter than the minimum, counted from #START", () => {
    expect(introEnd(input(INTRO_SKIP.minIntroSeconds))).toBe(
      INTRO_SKIP.minIntroSeconds - INTRO_SKIP.leadInSeconds,
    );
    expect(introEnd(input(INTRO_SKIP.minIntroSeconds - 0.5))).toBeNull();
    expect(introEnd(input(30, 25))).toBeNull();
    expect(introEnd(input(30, 15))).toBe(27);
  });

  it("is null when the first Note is past #END", () => {
    expect(introEnd({ ...input(30), endSeconds: 25 })).toBeNull();
  });
});

describe("offersSkipIntro", () => {
  it("offers it until shortly before the landing spot", () => {
    expect(offersSkipIntro(27, 0)).toBe(true);
    expect(offersSkipIntro(27, 25.9)).toBe(true);
    expect(offersSkipIntro(27, 26)).toBe(false);
    expect(offersSkipIntro(27, 40)).toBe(false);
    expect(offersSkipIntro(null, 0)).toBe(false);
  });
});

describe("secondsToSinging", () => {
  it("counts whole seconds to the first Note", () => {
    expect(secondsToSinging(27, 0)).toBe(30);
    expect(secondsToSinging(27, 0.5)).toBe(30);
    expect(secondsToSinging(27, 29.5)).toBe(1);
    expect(secondsToSinging(27, 31)).toBe(0);
  });
});
