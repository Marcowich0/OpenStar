/** Test helpers shared by the Timing edit model's tests. */

import type { ParsedSong } from "../generated/ParsedSong";
import type { SongHeaders } from "../generated/SongHeaders";
import { commit, type TimingEdit, type TimingModel } from "./timingModel";

/**
 * A solo Song with `#GAP:3650` and `#BPM:217.4` (the real beat rate is ×4).
 * Line k (0-based) has two Notes at Beats 40k and 40k + 4, two Beats long,
 * and a Line end marker at 40k + 8. File lines: Notes on 10 + 3k and
 * 11 + 3k, the marker on 12 + 3k.
 */
export function song(
  lineCount = 4,
  headers: Partial<SongHeaders> = {},
): ParsedSong {
  return {
    headers: {
      generation: "unversioned",
      version: null,
      encoding: null,
      title: "Placeholder",
      artist: "Nobody",
      audioReference: "song.mp3",
      mp3: "song.mp3",
      audio: null,
      video: null,
      cover: null,
      background: null,
      vocals: null,
      instrumental: null,
      beatsPerMinute: 217.4 * 4,
      gapSeconds: 3.65,
      startSeconds: null,
      endSeconds: null,
      videoGapSeconds: null,
      previewStartSeconds: null,
      medleyStartBeat: null,
      medleyEndBeat: null,
      year: null,
      genre: null,
      genres: [],
      language: null,
      languages: [],
      edition: null,
      editions: [],
      creator: null,
      creators: [],
      p1: null,
      p2: null,
      unknownHeaders: [],
      ...headers,
    },
    voices: [
      {
        lines: Array.from({ length: lineCount }, (_, k) => ({
          notes: [0, 1].map((i) => ({
            kind: "normal" as const,
            start: 40 * k + 4 * i,
            length: 2,
            pitch: 0,
            text: i === 0 ? "la " : "la",
            line: 10 + 3 * k + i,
          })),
          end:
            k < lineCount - 1 ? { beat: 40 * k + 8, line: 12 + 3 * k } : null,
        })),
      },
    ],
  };
}

/** `value`, failing the test when it is missing. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing value");
  return value;
}

/** Commits `edit` at `now` (ms), failing the test when the gesture made none. */
export function commitAt(model: TimingModel, edit: TimingEdit | null, now = 0) {
  return commit(model, must(edit), now);
}
