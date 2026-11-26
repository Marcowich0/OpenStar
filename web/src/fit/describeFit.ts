// A fit and a Line still off, in plain words (v1 spec #57, "Auto-fit on the
// desktop"): text keys plus parameters, so the desktop Timing editor and a
// Phone's Auto-fit show the same words. `fitText` and `lineSuggestionText`
// turn them into English through `t()`.

import type { ParsedSong } from "../generated/ParsedSong";
import { t } from "../i18n/t";
import type { LineSuggestion } from "./fit";

/** The timing a fit starts from or proposes, in file units, and its share. */
export interface FitValues {
  /** `#GAP` in whole ms. */
  readonly gapMs: number;
  /** `#BPM` as the file writes it. */
  readonly bpm: number;
  /** Notes on the singing (0–1), or `null` when no Note is scored. */
  readonly share: number | null;
}

export interface OffsetText {
  readonly key: "fit.offsetEarlier" | "fit.offsetLater";
  readonly params: { seconds: number; fromGap: number; toGap: number };
}

export interface TempoText {
  readonly key: "fit.tempoSlower" | "fit.tempoFaster";
  readonly params: { percent: number; fromBpm: number; toBpm: number };
}

export interface ShareText {
  readonly key: "fit.share";
  readonly params: { from: number; to: number };
}

export type FitDescription =
  | { readonly kind: "alreadyBest" }
  | {
      readonly kind: "fitted";
      /** `null` when `#GAP` stays. */
      readonly offset: OffsetText | null;
      /** `null` when `#BPM` stays (offset only). */
      readonly tempo: TempoText | null;
      readonly share: ShareText;
    };

const round2 = (x: number) => Math.round(x * 100) / 100;
const percentOf = (share: number | null) => Math.round((share ?? 0) * 100);

/**
 * A fit from `from` to `to`: the offset in seconds (to hundredths) with
 * earlier or later and `GAP old → new ms`; the tempo change as
 * `(oldBPM / newBPM − 1) × 100` to two decimals, slower when the new BPM is
 * lower, with `BPM old → new`; then the share before and after. The same
 * values on both sides are "Already the best fit".
 */
export function describeFit(from: FitValues, to: FitValues): FitDescription {
  if (from.gapMs === to.gapMs && from.bpm === to.bpm)
    return { kind: "alreadyBest" };
  const deltaMs = to.gapMs - from.gapMs;
  const offset: OffsetText | null =
    deltaMs === 0
      ? null
      : {
          key: deltaMs < 0 ? "fit.offsetEarlier" : "fit.offsetLater",
          params: {
            seconds: round2(Math.abs(deltaMs) / 1000),
            fromGap: from.gapMs,
            toGap: to.gapMs,
          },
        };
  const change = (from.bpm / to.bpm - 1) * 100;
  const tempo: TempoText | null =
    from.bpm === to.bpm
      ? null
      : {
          key: to.bpm < from.bpm ? "fit.tempoSlower" : "fit.tempoFaster",
          params: {
            percent: round2(Math.abs(change)),
            fromBpm: from.bpm,
            toBpm: to.bpm,
          },
        };
  return {
    kind: "fitted",
    offset,
    tempo,
    share: {
      key: "fit.share",
      params: { from: percentOf(from.share), to: percentOf(to.share) },
    },
  };
}

/**
 * A fit's words in English: the change ("notes 2.9 s earlier (…), tempo …"),
 * then the share ("Notes on the singing 15 % → 62 %."); or the one line
 * "Already the best fit the editor can find."
 */
export function fitText(d: FitDescription): string[] {
  if (d.kind === "alreadyBest") return [t("fit.alreadyBest")];
  const change = [
    d.offset ? t(d.offset.key, d.offset.params) : null,
    d.tempo ? t(d.tempo.key, d.tempo.params) : null,
  ].filter((part) => part !== null);
  return [change.join(t("fit.and")), t(d.share.key, d.share.params)];
}

export interface LineSuggestionDescription {
  readonly key: "fit.lineLater" | "fit.lineEarlier";
  readonly params: {
    /** 1-based within its Voice. */
    line: number;
    lyric: string;
    /** Whole Beats, without the sign (the key carries it). */
    count: number;
    from: number;
    to: number;
  };
}

/** The start of a lyric a Line list shows: about this many characters. */
const LYRIC_START = 16;

/** "Starry, starry night, paint…" → "Starry, starry…": cut at a word. */
function lyricStart(text: string): string {
  const whole = text.replace(/\s+/g, " ").trim();
  if (whole.length <= LYRIC_START) return whole;
  const cut = whole.slice(0, LYRIC_START + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : whole.slice(0, LYRIC_START)).replace(/[\s,;:.]+$/, "")}…`;
}

/** A Line still off: "Line 12 “Starry, starry…” +2 beats (31 → 74 %)". */
export function describeLineSuggestion(
  s: LineSuggestion,
  song: Pick<ParsedSong, "voices">,
): LineSuggestionDescription {
  const notes = song.voices[s.voice]?.lines[s.line]?.notes ?? [];
  return {
    key: s.beats < 0 ? "fit.lineEarlier" : "fit.lineLater",
    params: {
      line: s.line + 1,
      lyric: lyricStart(notes.map((n) => n.text).join("")),
      count: Math.abs(s.beats),
      from: percentOf(s.shareBefore),
      to: percentOf(s.shareAfter),
    },
  };
}

export function lineSuggestionText(d: LineSuggestionDescription): string {
  return t(d.key, d.params);
}
