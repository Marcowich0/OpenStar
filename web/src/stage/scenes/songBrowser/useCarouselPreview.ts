// The carousel preview (#162): the selected cover plays its Song's preview;
// a change of selection stops it until the next Song's detail is in, and
// leaving the song browser stops it.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { songQuery } from "../../../api/queries";
import type { SongDetail } from "../../../generated/SongDetail";
import type { SongId } from "../../../generated/SongId";
import { songPreview } from "../../../playback/songPreview";
import { stagePreview } from "../../playback/stagePreview";

/** Previews `songId` and returns its detail once loaded. */
export function useCarouselPreview(songId: SongId | null): SongDetail | null {
  const detail = useQuery({
    ...songQuery(songId ?? 0),
    enabled: songId !== null,
  }).data;
  const current = detail !== undefined && detail.id === songId ? detail : null;

  // The page's previewer (and its AudioContext) is made only once there is
  // something to play.
  const started = useRef(false);
  useEffect(() => {
    const preview = current === null ? null : songPreview(current);
    if (preview === null && !started.current) return;
    started.current = true;
    stagePreview().play(preview);
  }, [current]);

  useEffect(
    () => () => {
      if (started.current) stagePreview().stop();
    },
    [],
  );

  return current;
}
