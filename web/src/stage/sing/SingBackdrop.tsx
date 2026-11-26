// The sing screen's bottom layer (#55, "Video"): the music video full screen
// with `object-fit: cover`, over the backdrop that shows without a video or
// while it converts: the Song's background, then its cover, then its
// generated tile, placed like the video. The caller says when the video
// itself shows (`showVideo`: a separate video file shows once its position
// reached 0, #212). The media owner (#53) plays the element through
// `videoRef`; nothing here reads its position. A separate video file is
// muted: the Song's audio file carries the sound.

import { useState, type Ref } from "react";

import { avatarIconUrl } from "../../avatars/avatarIcons";
import type { SongMedia } from "../../generated/SongMedia";
import { tokenVar } from "../../theme/tokens";

export interface SingBackdropProps {
  media: SongMedia;
  /** `false` keeps the backdrop in front of the video (before position 0). */
  showVideo?: boolean;
  videoRef?: Ref<HTMLVideoElement>;
}

/** The video's URL when the Stage can play it as it is; `null`: the backdrop only. */
function playableVideo(media: SongMedia): string | null {
  const video = media.video;
  if (video === null) return null;
  const file = video.kind === "inAudio" ? media.audio : video.file;
  return file.native ? file.url : null;
}

export function SingBackdrop({
  media,
  showVideo = true,
  videoRef,
}: SingBackdropProps) {
  const video = playableVideo(media);
  return (
    <div className="absolute inset-0 overflow-hidden">
      <BackdropImage media={media} />
      {video !== null && (
        <video
          ref={videoRef}
          src={video}
          preload="auto"
          playsInline
          muted={media.video?.kind === "file"}
          className={`absolute inset-0 block size-full object-cover ${showVideo ? "" : "invisible"}`}
        />
      )}
    </div>
  );
}

/** The background, the cover, then the tile: each next one when the last fails. */
function BackdropImage({ media }: { media: SongMedia }) {
  const chain = [media.background, media.cover].filter(
    (url): url is string => url !== null,
  );
  const [failed, setFailed] = useState<readonly string[]>([]);
  const image = chain.find((url) => !failed.includes(url));
  if (image !== undefined) {
    return (
      <img
        key={image}
        src={image}
        alt=""
        draggable={false}
        className="absolute inset-0 block size-full object-cover"
        onError={() => {
          setFailed((f) => [...f, image]);
        }}
      />
    );
  }
  return (
    <div
      data-backdrop-tile
      className="absolute inset-0 flex items-center justify-center"
      style={{ backgroundColor: tokenVar(media.tileColour) }}
    >
      {/* The tile's mark, on a square covering the screen like the video. */}
      <div className="aspect-square shrink-0 p-[22%] opacity-35 [width:max(100vw,100vh)]">
        <svg viewBox="0 0 64 64" aria-hidden="true" className="size-full">
          <use
            href={avatarIconUrl("note", "glyph")}
            style={{ fill: tokenVar("--color-white") }}
          />
        </svg>
      </div>
    </div>
  );
}
