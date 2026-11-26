// One press during Check A/V sync (#163), from the Stage's ←/→ or a Remote's
// −/+ and Reset: the next A/V offset, and how the value shows.

import { AV_OFFSET, clampAvOffset } from "../avOffset/avOffset";
import type { AvSyncStep } from "../generated/AvSyncStep";
import { t } from "../i18n/t";

/** The offset after one press: 10 ms down or up within −300..+500, or 0. */
export function nextAvOffset(ms: number, step: AvSyncStep): number {
  switch (step) {
    case "down":
      return clampAvOffset(ms - AV_OFFSET.stepMs);
    case "up":
      return clampAvOffset(ms + AV_OFFSET.stepMs);
    case "reset":
      return AV_OFFSET.defaultMs;
  }
}

/** The value as it shows, with its sign: "+120 ms", "−40 ms", "0 ms". */
export function avOffsetText(ms: number): string {
  if (ms > 0) return t("avSync.later", { ms });
  if (ms < 0) return t("avSync.earlier", { ms: -ms });
  return t("avSync.zero");
}
