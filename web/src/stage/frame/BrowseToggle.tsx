// The way between the head's waiting Line-up and the song browser, so the
// Stage's keyboard and mouse always reach the song browser while a Queue
// waits. On the Line-up, a Browse songs pill in the top left; on the song
// browser over a waiting Line-up, an Up next banner in the bottom left that
// names the head's Song and goes back to its Line-up. `H` does either, in
// the scene layer only and never while typing. The frame holds the choice
// (`browsing`); the server's Party state still picks the scene under it.

import { useQuery } from "@tanstack/react-query";

import { songsQuery } from "../../api/queries";
import type { RequestId } from "../../generated/RequestId";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { Cover } from "../../ui/Cover";
import { isTextField } from "./focusables";
import { useStageFrame, useStageKeys } from "./stageFrameContext";

const PILL =
  "pointer-events-auto absolute top-12 left-12 inline-flex min-h-14 cursor-pointer items-center rounded-full bg-white px-7 text-2xl font-semibold text-ink shadow-ledge-sm";

const selectQueue = (live: LiveState) => live.stage?.party?.queue ?? null;

export function BrowseToggle() {
  const { scene, browsing, browseSongs, backToLineUp } = useStageFrame();
  useStageKeys({
    h: () => {
      if (isTextField(document.activeElement)) return false;
      if (browsing !== null) backToLineUp();
      else if (scene === "lineUp") browseSongs();
      else return false;
      return true;
    },
  });
  if (browsing !== null) return <UpNextBanner head={browsing} />;
  if (scene !== "lineUp") return null;
  return (
    <button type="button" className={PILL} onClick={browseSongs}>
      {t("stage.browse.songs")}
    </button>
  );
}

function UpNextBanner({ head }: { head: RequestId }) {
  const { store, backToLineUp } = useStageFrame();
  const queue = useLive(selectQueue, store);
  const songs = useQuery(songsQuery()).data?.songs;
  const songId = queue?.find((r) => r.requestId === head)?.songId;
  const song = songs?.find((s) => s.id === songId);
  const title = song?.title ?? "";
  return (
    <button
      type="button"
      data-testid="browse-up-next"
      aria-label={
        title === ""
          ? t("stage.browse.back")
          : t("stage.browse.backTo", { song: title })
      }
      onClick={backToLineUp}
      className="pointer-events-auto absolute bottom-12 left-12 flex max-w-[600px] cursor-pointer items-center gap-5 rounded-card-sm bg-white p-4 pr-8 text-left shadow-ledge-sm ring-6 ring-green"
    >
      <Cover
        src={song?.cover ?? null}
        song={song ?? null}
        rim={4}
        className="w-20 shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="self-start rounded-full bg-green px-4 text-xl font-semibold text-white">
          {t("queue.upNext")}
        </span>
        {title !== "" && (
          <span className="truncate text-3xl leading-tight font-semibold">
            {title}
          </span>
        )}
        <span className="text-2xl text-ink-2">{t("stage.browse.back")}</span>
      </span>
    </button>
  );
}
