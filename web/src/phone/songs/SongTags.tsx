// A Song's tags on the Phone: Preparing, Duet, year, length (the Request sheet only)
// and the top High score. Smaller than the Stage's `Chip`.

import { t } from "../../i18n/t";

export interface SongTagsProps {
  /** Still being converted for the Stage: it cannot be queued yet. */
  preparing?: boolean;
  duet: boolean;
  year: number | null;
  /** Shown only when given (the Request sheet). */
  lengthSeconds?: number | null;
  /** The Song's top High score at any Difficulty, or `null`. */
  best: number | null;
  className?: string;
}

const TAG =
  "rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap";

/** "3:53" for 233.4 seconds. */
export function songLength(seconds: number): string {
  const whole = Math.floor(seconds);
  return t("songs.length", {
    minutes: Math.floor(whole / 60),
    seconds: String(whole % 60).padStart(2, "0"),
  });
}

export function SongTags({
  preparing = false,
  duet,
  year,
  lengthSeconds,
  best,
  className = "",
}: SongTagsProps) {
  return (
    <span className={`flex flex-wrap gap-1.5 ${className}`}>
      {preparing && (
        <span className={`${TAG} bg-warn-bg text-warn-fg`}>
          {t("songs.preparing")}
        </span>
      )}
      {duet && (
        <span className={`${TAG} bg-purple text-white`}>{t("chip.duet")}</span>
      )}
      {year !== null && (
        <span className={`${TAG} bg-cream-2 text-ink-2`}>{String(year)}</span>
      )}
      {lengthSeconds !== undefined && lengthSeconds !== null && (
        <span className={`${TAG} bg-cream-2 text-ink-2`}>
          {songLength(lengthSeconds)}
        </span>
      )}
      {best !== null && (
        <span className={`${TAG} bg-yellow text-ink`}>
          {t("songs.best", { total: best })}
        </span>
      )}
    </span>
  );
}
