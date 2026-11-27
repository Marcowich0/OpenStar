// Skip intro on the sing screen: a pill at the right, above the lyric bar,
// while the Song plays an Intro (`playback/introSkip.ts`), counting down to
// the first Note. Pressing it (or Enter, `SingScene.tsx`) sends Skip intro
// through the server like any Remote. It goes shortly before the landing
// spot, when nothing worth skipping is left, and while the Song is paused or
// counting down.

import { useEffect, useState } from "react";

import type { SongClock } from "../../../clock/songClock";
import { t } from "../../../i18n/t";
import { offersSkipIntro, secondsToSinging } from "../../../playback/introSkip";
import { songLength } from "../../../phone/songs/SongTags";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";

/** How often the countdown and the pill's showing are checked. */
const TICK_MS = 250;

/**
 * Song time on `clock` every `TICK_MS` while `running`, for what follows Song
 * time only coarsely (no per-frame render).
 */
export function useCoarseSongTime(clock: SongClock, running: boolean): number {
  const [time, setTime] = useState(() => clock.songTime());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setTime(clock.songTime());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [clock, running]);
  return time;
}

export function SkipIntro({
  introEndSeconds,
  clock,
  playing,
  onSkip,
}: {
  /** Where Skip intro lands; `null` without an Intro. */
  introEndSeconds: number | null;
  clock: SongClock;
  /** The Song plays: not paused, counting down or ended. */
  playing: boolean;
  onSkip: () => void;
}) {
  const running = playing && introEndSeconds !== null;
  const now = useCoarseSongTime(clock, running);
  if (!running || !offersSkipIntro(introEndSeconds, now)) return null;
  const time = songLength(secondsToSinging(introEndSeconds, now));
  return (
    <div
      data-testid="skip-intro"
      className="absolute right-[3vw] bottom-[24vh] flex flex-col items-end gap-3"
    >
      <Button fill="white" onPress={onSkip}>
        <Icon name="fast-forward" className="size-8" />
        {t("stage.sing.skipIntro")}
      </Button>
      <p className="rounded-full bg-ink/70 px-5 py-1.5 text-2xl font-semibold text-white tabular-nums">
        {t("skipIntro.singingIn", { time })}
      </p>
    </div>
  );
}
