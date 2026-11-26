// The fit cases of `fixtures/fit/` as a parsed Song and a rendered Pitch track,
// for tests above the fit module (the Timing editor's Auto-fit). Test support only.

import alreadyBestText from "../../../fixtures/fit/already-best-fit.json?raw";
import bpmErrorText from "../../../fixtures/fit/gap-and-bpm-error.json?raw";
import melodyText from "../../../fixtures/fit/melody.json?raw";
import oneLineLateText from "../../../fixtures/fit/one-line-late.json?raw";
import type { ParsedSong } from "../generated/ParsedSong";
import { song as testSong } from "../timing/testSong";
import type { FitNote } from "./fit";
import { renderTrack, type SungSong } from "./syntheticTrack";

export interface FitCase {
  /** `#GAP` (ms) and `#BPM` as the file writes them. */
  file: { gap: number; bpm: number };
  sung: SungSong;
  seconds: number;
}

/** The shared melody's Notes (98 Notes on 14 Lines of one Voice). */
export const melody = (JSON.parse(melodyText) as { notes: FitNote[] }).notes;

export const fitCases = {
  /** GAP 3650 → 753 ms and BPM 217.4 → 216.26. */
  gapAndBpmError: JSON.parse(bpmErrorText) as FitCase,
  /** Sung as filed except Line index 5, sung 2 Beats late. */
  oneLineLate: JSON.parse(oneLineLateText) as FitCase,
  /** Sung exactly as filed. */
  alreadyBest: JSON.parse(alreadyBestText) as FitCase,
};

/**
 * The melody as a parsed Song with the case's file `#GAP`/`#BPM`: every Note's
 * lyric is "la ", file lines count up from 10, and no Line has an end marker.
 */
export function melodySong(c: FitCase): ParsedSong {
  const base = testSong(0, {
    gapSeconds: c.file.gap / 1000,
    beatsPerMinute: c.file.bpm * 4,
  });
  const lines: ParsedSong["voices"][number]["lines"] = [];
  let fileLine = 10;
  for (const n of melody) {
    const line = (lines[n.line] ??= { notes: [], end: null });
    line.notes.push({
      kind: n.kind,
      start: n.start,
      length: n.length,
      pitch: n.pitch,
      text: "la ",
      line: fileLine++,
    });
  }
  return { ...base, voices: [{ lines }] };
}

/** The case's Pitch track, as the fit module reads it. */
export function sungTrack(c: FitCase) {
  return renderTrack(melody, c.sung, c.seconds);
}
