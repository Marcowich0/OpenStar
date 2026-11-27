/**
 * How each edit reads in the Timing editor's edit list: a code plus
 * parameters, turned into text through `t()` by `describeEdit`.
 */

import { t } from "../i18n/t";

/** An edit's description, with the values before and after it. */
export type EditDescription =
  | {
      readonly kind: "moveSong";
      readonly fromGapMs: number;
      readonly toGapMs: number;
    }
  | {
      readonly kind: "nudgeSong";
      readonly fromGapMs: number;
      readonly toGapMs: number;
    }
  | {
      readonly kind: "typeGap";
      readonly fromGapMs: number;
      readonly toGapMs: number;
    }
  | {
      readonly kind: "typeBpm";
      readonly fromBpm: number;
      readonly toBpm: number;
    }
  | {
      readonly kind: "typeVideoGap";
      readonly fromSeconds: number | null;
      readonly toSeconds: number;
    }
  | {
      readonly kind: "stretchAroundPin" | "tempoAroundPlayhead";
      readonly fromGapMs: number;
      readonly toGapMs: number;
      readonly fromBpm: number;
      readonly toBpm: number;
    }
  | {
      /** Fit to the singing: `#GAP` and `#BPM` from the fit search. */
      readonly kind: "fitToTheSinging";
      readonly fromGapMs: number;
      readonly toGapMs: number;
      readonly fromBpm: number;
      readonly toBpm: number;
    }
  | {
      /** Fit to the singing, offset only: `#GAP` alone. */
      readonly kind: "fitOffsetOnly";
      readonly fromGapMs: number;
      readonly toGapMs: number;
    }
  | {
      /** A Line selection shifted (dragged, nudged or a Line suggestion). */
      readonly kind: "shiftLines";
      readonly voice: number;
      /** Indices into the Voice's `lines`. */
      readonly firstLine: number;
      readonly lastLine: number;
      /** The first Note's start Beat before and after. */
      readonly fromBeat: number;
      readonly toBeat: number;
    }
  | {
      readonly kind: "stretchLines";
      readonly voice: number;
      readonly firstLine: number;
      readonly lastLine: number;
      readonly factor: number;
    }
  | {
      readonly kind: "moveNote";
      readonly voice: number;
      /** Index into the Voice's `lines`. */
      readonly lineIndex: number;
      /** The Note's lyric, trimmed. */
      readonly text: string;
      readonly fromBeat: number;
      readonly toBeat: number;
    }
  | {
      readonly kind: "noteLength";
      readonly voice: number;
      readonly lineIndex: number;
      readonly text: string;
      readonly fromLength: number;
      readonly toLength: number;
    };

/**
 * The description of `later` merged into `earlier` (repeated nudges): the
 * values before come from the first nudge, the values after from the last.
 */
export function mergeDescriptions(
  earlier: EditDescription,
  later: EditDescription,
): EditDescription {
  const merged: Record<string, unknown> = { ...later };
  for (const [key, value] of Object.entries(earlier)) {
    if (key.startsWith("from")) merged[key] = value;
  }
  return merged as EditDescription;
}

/** The edit list's text for one edit. */
export function describeEdit(d: EditDescription): string {
  switch (d.kind) {
    case "moveSong":
      return t("timing.edit.moveSong", { from: d.fromGapMs, to: d.toGapMs });
    case "nudgeSong":
      return t("timing.edit.nudgeSong", { from: d.fromGapMs, to: d.toGapMs });
    case "typeGap":
      return t("timing.edit.typeGap", { from: d.fromGapMs, to: d.toGapMs });
    case "typeBpm":
      return t("timing.edit.typeBpm", { from: d.fromBpm, to: d.toBpm });
    case "typeVideoGap":
      return d.fromSeconds === null
        ? t("timing.edit.typeVideoGapNew", { to: d.toSeconds })
        : t("timing.edit.typeVideoGap", {
            from: d.fromSeconds,
            to: d.toSeconds,
          });
    case "stretchAroundPin":
    case "tempoAroundPlayhead":
      return t(`timing.edit.${d.kind}`, {
        fromBpm: d.fromBpm,
        toBpm: d.toBpm,
        fromGap: d.fromGapMs,
        toGap: d.toGapMs,
      });
    case "fitToTheSinging":
      return t("timing.edit.fitToTheSinging", {
        fromGap: d.fromGapMs,
        toGap: d.toGapMs,
        fromBpm: d.fromBpm,
        toBpm: d.toBpm,
      });
    case "fitOffsetOnly":
      return t("timing.edit.fitOffsetOnly", {
        fromGap: d.fromGapMs,
        toGap: d.toGapMs,
      });
    case "shiftLines":
      return byBeats(d.toBeat - d.fromBeat, {
        later: "timing.edit.shiftLinesLater",
        earlier: "timing.edit.shiftLinesEarlier",
        lines: linesText(d.firstLine, d.lastLine),
      });
    case "stretchLines":
      return t("timing.edit.stretchLines", {
        lines: linesText(d.firstLine, d.lastLine),
        factor: d.factor,
      });
    case "moveNote":
      return byBeats(d.toBeat - d.fromBeat, {
        later: "timing.edit.moveNoteLater",
        earlier: "timing.edit.moveNoteEarlier",
        lines: noteText(d.text, d.lineIndex),
      });
    case "noteLength":
      return t("timing.edit.noteLength", {
        note: noteText(d.text, d.lineIndex),
        from: d.fromLength,
        count: d.toLength,
      });
  }
}

/** "Line 3" or "Lines 3–5" (indices are 0-based, the text 1-based). */
function linesText(first: number, last: number): string {
  return first === last
    ? t("timing.lines.one", { line: first + 1 })
    : t("timing.lines.range", { first: first + 1, last: last + 1 });
}

/** "Note “la” in Line 3". */
function noteText(text: string, lineIndex: number): string {
  return t("timing.note", { text, line: lineIndex + 1 });
}

/** "+2 beats" or "−1 beat" after `lines`, by the sign of `beats`. */
function byBeats(
  beats: number,
  keys: {
    later: "timing.edit.shiftLinesLater" | "timing.edit.moveNoteLater";
    earlier: "timing.edit.shiftLinesEarlier" | "timing.edit.moveNoteEarlier";
    lines: string;
  },
): string {
  return t(beats < 0 ? keys.earlier : keys.later, {
    what: keys.lines,
    count: Math.abs(beats),
  });
}
