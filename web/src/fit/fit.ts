// The fit module: the match measure, Fit to the singing and Line suggestions.
//
// Pure TypeScript, shared by the desktop Timing editor (live while dragging) and a
// Phone's Auto-fit. It reads a downloaded Pitch track and a Song's Notes; it never
// touches the DOM, the network or the `.txt` bytes. Lifted from the timing-editor
// prototype's `buildMatcher` (`prototypes/timing-editor/timing.js`) with the
// constants of v1 spec #57.

import type { BeatGrid } from "../clock/beats";
import type { NoteKind } from "../generated/NoteKind";
import type { ParsedSong } from "../generated/ParsedSong";

/** Seconds between two frames of a Pitch track. */
export const FRAME_SECONDS = 0.01;

/**
 * The frames of a Pitch track the match measure reads: one pitch per 10 ms frame,
 * in Hz, 0 for an unvoiced frame. A full track (with clarity and RMS envelope)
 * fits this shape as it is.
 */
export interface PitchFrames {
  readonly pitch: ArrayLike<number>;
}

/**
 * The little the fit module needs of a Note. `voice` and `line` are indices into
 * `ParsedSong.voices` and that Voice's `lines`; `start` and `length` are in Beats
 * from `#GAP`; `pitch` is in semitones from C4.
 */
export interface FitNote {
  voice: number;
  line: number;
  kind: NoteKind;
  start: number;
  length: number;
  pitch: number;
}

/** Every Note of a parsed Song, in file order, as the fit module reads it. */
export function fitNotesOf(song: Pick<ParsedSong, "voices">): FitNote[] {
  return song.voices.flatMap((v, voice) =>
    v.lines.flatMap((l, line) =>
      l.notes.map((n) => ({
        voice,
        line,
        kind: n.kind,
        start: n.start,
        length: n.length,
        pitch: n.pitch,
      })),
    ),
  );
}

/** Only Normal and Golden notes are matched and counted. */
export function counts(kind: NoteKind): boolean {
  return kind === "normal" || kind === "golden";
}

/**
 * The pitch class of a voiced frame, in [0, 12) (0 = C), or `null` for an unvoiced
 * one.
 */
export function pitchClassOf(hz: number): number | null {
  if (!(hz > 0)) return null;
  return (((12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
}

/** Whether a frame of pitch class `pc` matches a Note of pitch `pitch`. */
export function frameMatches(pc: number | null, pitch: number): boolean {
  if (pc === null) return false;
  return Math.abs(((((pc - pitch + 18) % 12) + 12) % 12) - 6) <= 1;
}

/** Matching and covered frames of a set of Notes. */
interface Tally {
  matching: number;
  covered: number;
}

/** Which Line: indices into `ParsedSong.voices` and that Voice's `lines`. */
export interface LineRef {
  voice: number;
  line: number;
}

export interface LineShare extends LineRef {
  /** The Line's share, or `null` when none of its Notes counts. */
  share: number | null;
}

export interface Matcher {
  /** A Note's match share, or `null` for a Note that never counts. */
  noteShare(note: FitNote, grid: BeatGrid): number | null;
  /**
   * The share of a set of Notes (a Line, or the whole Song: "notes on the
   * singing"): matching frames over covered frames of the Notes that count, or
   * `null` when none counts.
   */
  share(notes: readonly FitNote[], grid: BeatGrid): number | null;
  /** Every Line's share, in the order the Lines first appear in `notes`. */
  lineShares(notes: readonly FitNote[], grid: BeatGrid): LineShare[];
  /**
   * The fit search: the `#GAP` and `#BPM` (or, with `tempo: false`, the `#GAP`
   * alone) that put `notes`, in file order, best on the singing.
   */
  fitToTheSinging(
    notes: readonly FitNote[],
    grid: BeatGrid,
    options: { tempo: boolean },
  ): FitResult;
  /**
   * The Lines still off the singing: each Line that moved alone by a whole number
   * of Beats would gain at least 0.20 of share and reach at least 0.50, in the
   * order the Lines first appear in `notes`.
   */
  lineSuggestions(notes: readonly FitNote[], grid: BeatGrid): LineSuggestion[];
}

export interface LineSuggestion extends LineRef {
  /** Whole Beats to move the Line by: positive is later. */
  beats: number;
  /** The Line's share where it is now. */
  shareBefore: number;
  /** The Line's share once moved by `beats`. */
  shareAfter: number;
}

/** Line suggestions try each Line from −1.5 s to +1.5 s in 10 ms steps. */
const LINE_OFFSET = { step: 0.01, steps: 150 };
const MIN_RISE = 0.2;
const MIN_SHARE_AFTER = 0.5;
/** Shares are ratios of frame counts; this keeps "at least" exact at the thresholds. */
const EPSILON = 1e-9;

/**
 * A fit: the proposed grid and the Song's share under it. `gapSeconds` is a whole
 * millisecond and `beatsPerMinute` four times a `#BPM` in hundredths; when nothing
 * beats the starting values, the grid passed in comes back unchanged
 * ("Already the best fit").
 */
export interface FitResult extends BeatGrid {
  share: number | null;
}

/** The fit search's scans: centre ± width in steps, as step counts. */
const COARSE_OFFSET = { step: 0.04, steps: 250 }; // −10 s … +10 s
const COARSE_SCALE = { step: 0.0005, steps: 60 }; // 0.97 … 1.03
const FINE_OFFSET = { step: 0.002, steps: 30 }; // ±60 ms
const FINE_SCALE = { step: 0.00005, steps: 12 }; // ±0.0006

/** `centre + i × step` for i in −steps … +steps, without accumulating error. */
function scan(
  centre: number,
  { step, steps }: { step: number; steps: number },
): number[] {
  return Array.from(
    { length: 2 * steps + 1 },
    (_, i) => centre + (i - steps) * step,
  );
}

/** Builds the match measure for one Pitch track (per-pitch-class prefix sums). */
export function createMatcher(track: PitchFrames): Matcher {
  const frames = track.pitch.length;
  // prefix[p][i] = matching frames for pitch class p among frames [0, i).
  const prefix: Int32Array[] = [];
  const classes = Array.from({ length: frames }, (_, i) =>
    pitchClassOf(track.pitch[i] ?? 0),
  );
  for (let p = 0; p < 12; p++) {
    const sums = new Int32Array(frames + 1);
    for (let i = 0; i < frames; i++) {
      sums[i + 1] =
        (sums[i] ?? 0) + (frameMatches(classes[i] ?? null, p) ? 1 : 0);
    }
    prefix.push(sums);
  }

  const frameAt = (t: number) =>
    Math.max(0, Math.min(frames, Math.round(t / FRAME_SECONDS)));

  /** Adds one Note placed at [t0, t1) to `tally`. */
  function add(tally: Tally, pitch: number, t0: number, t1: number): void {
    const i0 = frameAt(t0);
    const i1 = frameAt(t1);
    const sums = prefix[((pitch % 12) + 12) % 12] as Int32Array;
    tally.matching += (sums[i1] ?? 0) - (sums[i0] ?? 0);
    tally.covered += Math.max(1, i1 - i0);
  }

  /** The tally of the counted Notes, placed with `gap` (s) and `s` seconds per Beat. */
  function tallyOf(notes: readonly FitNote[], gap: number, s: number): Tally {
    const tally = { matching: 0, covered: 0 };
    for (const n of notes) {
      if (counts(n.kind))
        add(tally, n.pitch, gap + n.start * s, gap + (n.start + n.length) * s);
    }
    return tally;
  }

  const share = (notes: readonly FitNote[], grid: BeatGrid) =>
    shareOf(tallyOf(notes, grid.gapSeconds, 60 / grid.beatsPerMinute));

  function fitToTheSinging(
    notes: readonly FitNote[],
    grid: BeatGrid,
    { tempo }: { tempo: boolean },
  ): FitResult {
    const pivot = notes[Math.floor(notes.length / 2)];
    if (!pivot) return { ...grid, share: null };
    const s0 = 60 / grid.beatsPerMinute;
    const t0 = grid.gapSeconds + pivot.start * s0;
    // A candidate (offset o, tempo scale k) keeps the pivot Note at T₀ + o.
    const gapAt = (o: number, k: number) => t0 + o - pivot.start * s0 * k;
    const shareAt = (o: number, k: number) =>
      shareOf(tallyOf(notes, gapAt(o, k), s0 * k)) ?? 0;

    let best = { o: 0, k: 1, share: shareAt(0, 1) };
    const search = (offsets: number[], scales: number[]) => {
      for (const k of scales) {
        for (const o of offsets) {
          const v = shareAt(o, k);
          if (v > best.share) best = { o, k, share: v };
        }
      }
    };
    search(scan(0, COARSE_OFFSET), tempo ? scan(1, COARSE_SCALE) : [1]);
    search(scan(best.o, FINE_OFFSET), tempo ? scan(best.k, FINE_SCALE) : [1]);

    if (best.o === 0 && best.k === 1)
      return { ...grid, share: share(notes, grid) };
    const s = s0 * best.k;
    const fitted = {
      gapSeconds: Math.round(gapAt(best.o, best.k) * 1000) / 1000,
      beatsPerMinute: tempo
        ? (Math.round((60 / (4 * s)) * 100) / 100) * 4
        : grid.beatsPerMinute,
    };
    return { ...fitted, share: share(notes, fitted) };
  }

  function lineSuggestions(
    notes: readonly FitNote[],
    grid: BeatGrid,
  ): LineSuggestion[] {
    const s = 60 / grid.beatsPerMinute;
    const shareMovedBy = (line: readonly FitNote[], o: number) =>
      shareOf(tallyOf(line, grid.gapSeconds + o, s)) ?? 0;
    const out: LineSuggestion[] = [];
    for (const l of linesOf(notes)) {
      const shareBefore = share(l.notes, grid);
      if (shareBefore === null) continue;
      let best = { o: 0, share: shareBefore };
      for (const o of scan(0, LINE_OFFSET)) {
        const v = shareMovedBy(l.notes, o);
        if (v > best.share) best = { o, share: v };
      }
      const beats = Math.round(best.o / s);
      if (beats === 0) continue;
      const shareAfter = shareMovedBy(l.notes, beats * s);
      if (
        shareAfter - shareBefore >= MIN_RISE - EPSILON &&
        shareAfter >= MIN_SHARE_AFTER - EPSILON
      ) {
        out.push({
          voice: l.voice,
          line: l.line,
          beats,
          shareBefore,
          shareAfter,
        });
      }
    }
    return out;
  }

  return {
    lineSuggestions,
    fitToTheSinging,
    noteShare: (note, grid) => (counts(note.kind) ? share([note], grid) : null),
    share,
    lineShares: (notes, grid) =>
      linesOf(notes).map((l) => ({
        voice: l.voice,
        line: l.line,
        share: share(l.notes, grid),
      })),
  };
}

function shareOf(tally: Tally): number | null {
  return tally.covered > 0 ? tally.matching / tally.covered : null;
}

interface LineNotes extends LineRef {
  notes: FitNote[];
}

/** The Notes grouped by Line, in the order the Lines first appear. */
export function linesOf(notes: readonly FitNote[]): LineNotes[] {
  const byKey = new Map<string, LineNotes>();
  for (const n of notes) {
    const key = `${String(n.voice)}:${String(n.line)}`;
    let l = byKey.get(key);
    if (!l) {
      l = { voice: n.voice, line: n.line, notes: [] };
      byKey.set(key, l);
    }
    l.notes.push(n);
  }
  return [...byKey.values()];
}

/** The share at which a Line shows fully green in the overview strip. */
const GREEN_AT = 0.625;
const RED_HUE = 0;
const GREEN_HUE = 120;

/**
 * A Line's overview colour as a hue in degrees: red (0) at share 0, rising evenly
 * to green (120) at share 0.625 and above. Saturation and lightness are the
 * design's.
 */
export function overviewHue(share: number): number {
  const t = Math.min(1, Math.max(0, share) / GREEN_AT);
  return RED_HUE + t * (GREEN_HUE - RED_HUE);
}
