import { describe, expect, it } from "vitest";

import type { SongMedia } from "../generated/SongMedia";
import { playbackPlan, type PlanInput } from "./playbackPlan";

const AUDIO = { url: "/api/songs/7/media/audio", native: true };

function input(
  media: Partial<SongMedia> = {},
  headers: { startSeconds?: number | null; endSeconds?: number | null } = {},
  loudnessLufs: number | null = null,
): PlanInput {
  return {
    media: {
      audio: AUDIO,
      video: null,
      cover: null,
      background: null,
      tileColour: "cherry",
      ...media,
    },
    song: {
      headers: { startSeconds: null, endSeconds: null, ...headers },
    },
    loudnessLufs,
  };
}

describe("how the Stage plays a Song", () => {
  it("plays a Song without video through an audio element, clocked from currentTime", () => {
    expect(playbackPlan(input())).toEqual({
      element: "audio",
      url: AUDIO.url,
      clock: "audio",
      startSeconds: 0,
      endSeconds: null,
      loudnessLufs: null,
    });
  });

  it("plays one file named as audio and video as both, in a video element, ignoring #VIDEOGAP", () => {
    const plan = playbackPlan(input({ video: { kind: "inAudio" } }));
    expect(plan).toMatchObject({
      element: "video",
      url: AUDIO.url,
      clock: "video",
      startSeconds: 0,
    });
  });

  it("plays media that needed conversion from the URL the converted copy is served at", () => {
    // The server serves the cache copy at the Song's own media URL and marks it native.
    const converted = { url: "/api/songs/9/media/audio", native: true };
    expect(
      playbackPlan(input({ audio: converted, video: { kind: "inAudio" } })),
    ).toMatchObject({ element: "video", url: converted.url });
  });

  it("does not play a one-file video that is still converting as a video", () => {
    const converting = { url: AUDIO.url, native: false };
    expect(
      playbackPlan(input({ audio: converting, video: { kind: "inAudio" } })),
    ).toMatchObject({ element: "audio", clock: "audio" });
  });

  it("plays only the audio of separate audio and video files (ticket 212 makes the video follow)", () => {
    const plan = playbackPlan(
      input({
        video: {
          kind: "file",
          file: { url: "/api/songs/7/media/video", native: true },
          gapSeconds: 1.5,
        },
      }),
    );
    expect(plan).toMatchObject({
      element: "audio",
      url: AUDIO.url,
      clock: "audio",
    });
  });

  it("begins at #START and stops at #END", () => {
    expect(
      playbackPlan(input({}, { startSeconds: 12.5, endSeconds: 95.25 })),
    ).toMatchObject({ startSeconds: 12.5, endSeconds: 95.25 });
  });

  it("plays to the end of the audio without #END, however early the last Note is", () => {
    expect(playbackPlan(input({}, { startSeconds: 3 }))).toMatchObject({
      startSeconds: 3,
      endSeconds: null,
    });
  });

  it("ignores an #END at or before #START, and a negative #START", () => {
    expect(
      playbackPlan(input({}, { startSeconds: 30, endSeconds: 30 })),
    ).toMatchObject({ startSeconds: 30, endSeconds: null });
    expect(playbackPlan(input({}, { startSeconds: -2 }))).toMatchObject({
      startSeconds: 0,
    });
  });

  it("carries the Song's measured loudness for the Song gain", () => {
    expect(playbackPlan(input({}, {}, -24)).loudnessLufs).toBe(-24);
  });
});
