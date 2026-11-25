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
  }
}
