/**
 * The Stage's one song-browser preview player (#162), made on first use. It
 * plays through the Stage's `AudioContext` into the chain's input, after the
 * Song gain, so the OpenStar volume applies to previews as to Songs. The
 * carousel (#55) calls `stagePreview().play(songPreview(detail))` on each
 * selection; Calibrate mics (#170) and Check A/V sync (#163) call `stop()`.
 * Each preview fades in to the Stage options' preview volume.
 */

import {
  createSongPreviewer,
  type SongPreviewer,
} from "../../playback/songPreview";
import { previewGain, stageOptions } from "../../stageOptions/stageOptions";
import { stageAudio, type StageAudio } from "./stageAudio";

export function createStagePreview(audio: StageAudio): SongPreviewer {
  return createSongPreviewer({
    context: audio.context(),
    output: audio.chain().input,
    level: () => previewGain(stageOptions().current().previewVolumePercent),
  });
}

let preview: SongPreviewer | null = null;

/** The Stage's preview player, one per page. */
export function stagePreview(): SongPreviewer {
  preview ??= createStagePreview(stageAudio());
  return preview;
}
