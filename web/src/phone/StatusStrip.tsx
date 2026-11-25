import { useQuery } from "@tanstack/react-query";

import { songQuery } from "../api/queries";
import { t } from "../i18n/t";
import { Cover } from "../ui/Cover";
import { Icon } from "../ui/Icon";
import type { StatusStrip as Strip } from "./remoteFrame";

/**
 * The status strip above the tabs (v1 spec #49, "The Remote frame"): while a
 * Line-up waits, "Line-up for <Song>" and "Waiting for Start". Tapping it
 * opens the Stage tab. #160 adds the playing Song with Pause/Resume.
 */
export function StatusStrip({
  strip,
  onOpenStage,
}: {
  strip: Strip;
  onOpenStage: () => void;
}) {
  const song = useQuery(songQuery(strip.songId)).data;
  const title = song?.song.headers.title ?? "";
  return (
    <button
      type="button"
      onClick={onOpenStage}
      className="mx-2.5 mb-2 flex cursor-pointer items-center gap-2.5 rounded-[22px] bg-ink py-2 pr-2 pl-3 text-left text-white outline-none focus-visible:outline-4 focus-visible:outline-yellow"
    >
      <Cover
        src={song?.media.cover ?? null}
        tileColour={song?.media.tileColour ?? "teal"}
        rim={2}
        className="w-10"
      />
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
