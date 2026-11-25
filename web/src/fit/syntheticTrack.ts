// Renders the Pitch track of a synthetic sine-melody Song, for the fit module's
// fixture tests (fixtures/fit/README.md describes the rule). Test support only.

import { FRAME_SECONDS, counts, type FitNote, type LineRef } from "./fit";

/** How the synthetic singer sings a melody: its own `#GAP`/`#BPM` and changes. */
export interface SungSong {
  /** `#GAP` in ms. */
  gap: number;
  /** `#BPM` as a file writes it (a Beat lasts 15 / bpm s). */
  bpm: number;
  /** Semitones every Note is sung away from its pitch (−12: an octave lower). */
  transpose: number;
  /** Lines sung whole Beats late (positive) or early (negative). */
  lineShifts: (LineRef & { beats: number })[];
}

const VIBRATO_SEMITONES = 0.3;
const VIBRATO_HZ = 5.5;

/** A Pitch track of `seconds` s: one pitch (Hz, 0 = unvoiced) per 10 ms frame. */
export function renderTrack(
  notes: readonly FitNote[],
  sung: SungSong,
  seconds: number,
) {
  const pitch = new Float32Array(Math.round(seconds / FRAME_SECONDS));
  const gap = sung.gap / 1000;
  const s = 15 / sung.bpm;
  for (const n of notes) {
    if (n.kind === "freestyle") continue;
    const shift =
      sung.lineShifts.find((l) => l.voice === n.voice && l.line === n.line)
        ?.beats ?? 0;
    const t0 = gap + (n.start + shift) * s;
    const t1 = t0 + n.length * s;
    // Rap notes are spoken: voiced, a tritone away, so they would never match.
    const semitones = n.pitch + sung.transpose + (counts(n.kind) ? 0 : 6);
    for (
      let i = Math.max(0, Math.floor(t0 / FRAME_SECONDS) - 1);
      i < pitch.length;
      i++
    ) {
      const t = (i + 0.5) * FRAME_SECONDS;
      if (t > t1) break;
      if (t <= t0) continue;
      const vibrato =
        VIBRATO_SEMITONES * Math.sin(2 * Math.PI * VIBRATO_HZ * (t - t0));
      pitch[i] = 440 * 2 ** ((semitones + vibrato - 9) / 12);
    }
  }
  return { pitch };
}
