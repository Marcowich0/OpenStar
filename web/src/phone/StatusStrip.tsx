import { useQuery } from "@tanstack/react-query";

import { songQuery } from "../api/queries";
import { t } from "../i18n/t";
import type { LiveStore } from "../live/liveStore";
import { Cover } from "../ui/Cover";
import { Icon } from "../ui/Icon";
import { controlSong, usePlayerNames } from "./onStage/playing";
import type { StatusStrip as Strip } from "./remoteFrame";

const STRIP =
  "mx-2.5 mb-2 flex items-center gap-2.5 rounded-[22px] bg-ink-fill py-2 pr-2 pl-3 text-white";
const FOCUS =
  "outline-none focus-visible:outline-4 focus-visible:outline-yellow";

/**
 * The status strip above the tabs (v1 spec #49, "The Remote frame"). While a
 * Song plays or is paused: the cover, the Song title and its Players' names,
 * with a round Pause/Resume beside it (a plain tap). While a Line-up waits:
 * "Line-up for <Song>" and "Waiting for Start". Tapping the strip opens the
 * Stage tab.
 */
export function StatusStrip({
  store,
  strip,
  onOpenStage,
}: {
  store: LiveStore;
  strip: Strip;
  onOpenStage: () => void;
}) {
  const song = useQuery(songQuery(strip.songId)).data;
  const title = song?.song.headers.title ?? "";
  const players = usePlayerNames(
    store,
    strip.kind === "playing" ? strip.players : [],
  );
  const cover = (
    <Cover
      src={song?.media.cover ?? null}
      tileColour={song?.media.tileColour ?? "teal"}
      rim={2}
      className="w-10 shrink-0"
    />
  );

  if (strip.kind === "playing") {
    return (
      <div className={STRIP}>
        <button
          type="button"
          onClick={onOpenStage}
          className={`flex min-w-0 grow cursor-pointer items-center gap-2.5 rounded-[16px] text-left ${FOCUS}`}
        >
          {cover}
          <span className="flex min-w-0 grow flex-col">
            <span className="truncate font-semibold">{title}</span>
            <span className="truncate text-sm text-white/70">{players}</span>
          </span>
        </button>
        <button
          type="button"
          aria-label={t(strip.paused ? "remote.resume" : "remote.pause")}
          onClick={() => {
            controlSong(
              store,
              strip.requestId,
              strip.paused ? "resume" : "pause",
            );
          }}
          className={`flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface text-ink shadow-ledge ${FOCUS}`}
        >
          <Icon name={strip.paused ? "play" : "pause"} className="size-6" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenStage}
      className={`${STRIP} cursor-pointer text-left ${FOCUS}`}
    >
      {cover}
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate font-semibold">
          {t("remote.lineUpFor", { song: title })}
        </span>
        <span className="text-sm text-yellow">
          {t("remote.waitingForStart")}
        </span>
      </span>
      <Icon name="chevron" className="size-6 shrink-0" />
    </button>
  );
}
