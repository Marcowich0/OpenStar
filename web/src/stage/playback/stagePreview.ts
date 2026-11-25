/**
 * The Stage's one song-browser preview player (#162), made on first use. It
 * plays through the Stage's `AudioContext` into the chain's input, after the
 * Song gain, so the OpenStar volume applies to previews as to Songs. The
 * carousel (#55) calls `stagePreview().play(songPreview(detail))` on each
 * selection; Calibrate mics (#170) and Check A/V sync (#163) call `stop()`.
 */

import {
  createSongPreviewer,
  type SongPreviewer,
} from "../../playback/songPreview";
import { stageAudio, type StageAudio } from "./stageAudio";

export function createStagePreview(audio: StageAudio): SongPreviewer {
  return createSongPreviewer({
    context: audio.context(),
    output: audio.chain().input,
  });
}

let preview: SongPreviewer | null = null;

/** The Stage's preview player, one per page. */
export function stagePreview(): SongPreviewer {
  preview ??= createStagePreview(stageAudio());
  return preview;
}
