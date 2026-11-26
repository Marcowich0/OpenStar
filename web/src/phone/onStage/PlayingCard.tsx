// The Stage tab's card while a Song plays or is paused (v1 spec #49, "Stage
// tab"): the cover, title and Players, the progress, Pause/Resume as a plain
// tap, and Restart, Skip and End as hold buttons. The progress is
// extrapolated from the Stage's position reports (#159); the Phone is never
// told Song time.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { songQuery } from "../../api/queries";
import { t } from "../../i18n/t";
import type { IconName } from "../../icons/icons";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { progressAt } from "../../live/songProgress";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { Cover } from "../../ui/Cover";
import { HoldButton } from "../../ui/HoldButton";
import { Icon } from "../../ui/Icon";
import type { StageState } from "../remoteFrame";
import { songLength } from "../songs/SongTags";
import { controlSong, usePlayerNames } from "./playing";

/** How often the progress moves on between reports. */
const PROGRESS_TICK_MS = 250;

const HOLDS = [
  { control: "restart", label: "stageTab.restart", icon: "restart" },
  { control: "skip", label: "stageTab.skip", icon: "skip" },
  { control: "end", label: "stageTab.end", icon: "stop" },
] as const satisfies readonly {
  control: string;
  label: string;
  icon: IconName;
}[];

const selectProgress = (state: LiveState) => state.songProgress;

export function PlayingCard({
  store,
  playing,
}: {
  store: LiveStore;
  playing: Extract<StageState, { kind: "playing" }>;
}) {
  const song = useQuery(songQuery(playing.songId)).data;
  const players = usePlayerNames(store, playing.players);
  const { requestId, paused } = playing;

  return (
    <section
      data-testid="playing-card"
      className="flex flex-col gap-3 rounded-card bg-ink p-4.5 text-white shadow-ledge"
    >
      <div className="flex items-center gap-3">
        <Cover
          src={song?.media.cover ?? null}
          tileColour={song?.media.tileColour ?? "teal"}
          rim={2}
          className="w-13 shrink-0"
        />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-semibold text-green">
            {t(paused ? "stageTab.paused" : "stageTab.playingNow")}
          </p>
          <h2 className="truncate text-xl font-bold">
            {song?.song.headers.title ?? ""}
          </h2>
          <p className="truncate text-white/70">{players}</p>
        </div>
      </div>

      <Progress store={store} fallbackLength={song?.lengthSeconds ?? null} />

      <Button
        fill="white"
        className="w-full"
        onPress={() => {
          controlSong(store, requestId, paused ? "resume" : "pause");
        }}
      >
        <Icon name={paused ? "play" : "pause"} className="size-7" />
        {t(paused ? "stageTab.resume" : "stageTab.pause")}
      </Button>
      <div className="grid grid-cols-3 gap-2">
        {HOLDS.map(({ control, label, icon }) => (
          <HoldButton
            key={control}
            fill="white"
            size="small"
            onHold={() => {
              controlSong(store, requestId, control);
            }}
          >
            <Icon name={icon} className="size-5 shrink-0" />
            {t(label)}
          </HoldButton>
        ))}
      </div>
      <p className="text-center text-sm text-white/60">
        {t("stageTab.holdHint")}
      </p>
    </section>
  );
}

/**
 * The bar and the times. Re-renders on a timer while the Song runs, and
 * shows the Song's own length until the Stage's first report. The mic
 * takeover's Singing step shows it too.
 */
export function Progress({
  store,
  fallbackLength,
}: {
  store: LiveStore;
  fallbackLength: number | null;
}) {
  const anchor = useLive(selectProgress, store);
  const [now, setNow] = useState(() => performance.now());
  // Paused or ended, the reported position holds whatever `now` is; a
  // fresh report while it runs is caught up by the next tick.
  const running = anchor !== null && anchor.rate > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(performance.now());
    }, PROGRESS_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  const value = anchor ? progressAt(anchor, now) : null;
  const position = value?.positionSeconds ?? 0;
  const length = value ? value.lengthSeconds : fallbackLength;
  const percent = Math.round((value?.fraction ?? 0) * 100);

  return (
    <div className="flex items-center gap-2.5 text-sm text-white/70 tabular-nums">
      <span>{songLength(position)}</span>
      <div
        role="progressbar"
        aria-label={t("stageTab.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 grow overflow-hidden rounded-full bg-white/15"
      >
        <div
          className="h-full rounded-full bg-green"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <span>{length === null ? "" : songLength(length)}</span>
    </div>
  );
}
