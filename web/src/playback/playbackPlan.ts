/**
 * What the Stage plays for a Song (#53, "What plays the Song"): one media
 * element, a `<video>` when the Song's one file holds the video, else an
 * `<audio>`; where it begins (`#START`) and where it stops (`#END`, else the
 * end of the audio, never at the last Note).
 */

import type { SongDetail } from "../generated/SongDetail";
import type { SongHeaders } from "../generated/SongHeaders";
import type { ClockMedia } from "../clock/songClock";

export interface PlanInput extends Pick<SongDetail, "media" | "loudnessLufs"> {
  song: { headers: Pick<SongHeaders, "startSeconds" | "endSeconds"> };
}

export interface PlaybackPlan {
  /** The one media element that plays the Song. */
  element: "video" | "audio";
  /** What it plays. A converted copy is served at the Song's own URL. */
  url: string;
  /** Where the Song clock reads the position from. */
  clock: ClockMedia;
  /** `#START`: where playback begins, seconds of audio. */
  startSeconds: number;
  /** `#END`: where playback stops, seconds of audio; `null`: the end of the audio. */
  endSeconds: number | null;
  /** The Song's measured loudness (`null`: unmeasured, unity gain). */
  loudnessLufs: number | null;
  /**
   * Separate audio and video files (#212): the muted video that follows the
   * audio at *audio position + `#VIDEOGAP`*. `null` without one, for one file
   * that plays as both, and while the video still converts (backdrop only).
   */
  follow: FollowingVideo | null;
}

export interface FollowingVideo {
  url: string;
  /** `#VIDEOGAP`, seconds. */
  gapSeconds: number;
}

export function playbackPlan({
  media,
  song,
  loudnessLufs,
}: PlanInput): PlaybackPlan {
  // One file named as audio and video plays as both, `#VIDEOGAP` ignored.
  // A converting one (not native) plays as sound only, like the backdrop
  // (`SingBackdrop`) shows no video for it. Separate files: the audio plays
  // and is the clock; the video follows it (when it can play as it is).
  const video = media.video?.kind === "inAudio" && media.audio.native;
  const startSeconds = Math.max(song.headers.startSeconds ?? 0, 0);
  const end = song.headers.endSeconds;
  return {
    element: video ? "video" : "audio",
    url: media.audio.url,
    clock: video ? "video" : "audio",
    startSeconds,
    endSeconds: end !== null && end > startSeconds ? end : null,
    loudnessLufs,
    follow:
      media.video?.kind === "file" && media.video.file.native
        ? { url: media.video.file.url, gapSeconds: media.video.gapSeconds }
        : null,
  };
}
