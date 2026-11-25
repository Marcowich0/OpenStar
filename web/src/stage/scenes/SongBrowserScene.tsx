// The song browser (v1 spec #55, "Song browser and join card"): the Stage's
// resting scene whenever the Queue is empty. The logo, the big cover
// carousel, the selected Song's info and the breathing Sing!, which adds it
// as a Request from the Stage; the head of the Queue then shows its Line-up.
// The join card in the corner is a placeholder until #178 builds it (keep
// `data-testid="party-join-code"`: the e2e tests read it).

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { songsQuery } from "../../api/queries";
import type { SongId } from "../../generated/SongId";
import type { SongSummary } from "../../generated/SongSummary";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { tokenVar } from "../../theme/tokens";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { useStageFrame } from "../frame/stageFrameContext";
import { CAROUSEL_ARROWS, SongCarousel } from "./songBrowser/SongCarousel";
import { SongInfo } from "./songBrowser/SongInfo";
import { addStageRequest } from "./songBrowser/stageRequest";
import { useCarouselPreview } from "./songBrowser/useCarouselPreview";

const selectJoinCode = (live: LiveState) => live.stage?.party?.joinCode ?? null;

/** The logo's star, on a 64-unit grid. */
const STAR = "M32 4l8 18 19 2-14 13 4 19-17-10-17 10 4-19L5 24l19-2z";

export function SongBrowserScene() {
  const { store } = useStageFrame();
  const songs = useQuery(songsQuery()).data?.songs;
  const [selectedId, setSelectedId] = useState<SongId | null>(null);
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<UserMessage | null>(null);

  // The selection is kept by Song, so it survives a Library change.
  const found = songs?.findIndex((s) => s.id === selectedId) ?? -1;
  const index = found === -1 ? 0 : found;
  const song: SongSummary | undefined = songs?.[index];
  const detail = useCarouselPreview(song?.id ?? null);

  const select = (next: number) => {
    const nextSong = songs?.[next];
    if (!nextSong) return;
    setSelectedId(nextSong.id);
    setRefusal(null);
  };

  const sing = (picked: SongSummary) => {
    if (picked.preparing || adding) return;
    setAdding(true);
    setRefusal(null);
    void addStageRequest(store, picked.id).then((result) => {
      setAdding(false);
      if (!result.ok) setRefusal(result.reason);
    });
  };

  return (
    <section className="relative size-full">
      <header
        data-testid="stage-logo"
        className="absolute top-10 left-15 flex items-center gap-2.5 text-[64px] font-bold"
      >
        <svg
          viewBox="0 0 64 64"
          aria-hidden="true"
          className="size-18 motion-safe:animate-bob"
        >
          <path
            d={STAR}
            strokeWidth="4"
            strokeLinejoin="round"
            style={{
              fill: tokenVar("--color-yellow"),
              stroke: tokenVar("--color-ink"),
            }}
          />
        </svg>
        {t("stage.logo")}
      </header>

      {songs !== undefined && song === undefined && (
        <p className="absolute inset-x-0 top-[420px] text-center text-6xl font-bold text-ink-2">
          {t("stage.browser.empty")}
        </p>
      )}

      {songs && song && (
        <>
          <SongCarousel
            songs={songs}
            selected={index}
            onSelect={select}
            onPick={sing}
            className="absolute inset-x-0 top-[190px] h-[460px]"
          />
          <SongInfo
            song={song}
            genre={detail?.song.headers.genre ?? null}
            className="absolute inset-x-0 top-[690px]"
          />
          <div
            {...{ [CAROUSEL_ARROWS]: "" }}
            className="absolute bottom-14 left-1/2 -translate-x-1/2"
          >
            <Button
              fill="green"
              size="big"
              breathing
              isDisabled={song.preparing}
              onPress={() => {
                sing(song);
              }}
              className="px-[84px] text-[56px]"
            >
              {t("stage.sing")}
            </Button>
            {refusal && (
              <span className="absolute top-1/2 left-full ml-10 -translate-y-1/2">
                <Chip tone="warn">{userMessageText(refusal)}</Chip>
              </span>
            )}
          </div>
        </>
      )}

      <JoinCardPlaceholder />
    </section>
  );
}

/** Until the join card (#178): the Join code in the bottom-right corner. */
function JoinCardPlaceholder() {
  const { store } = useStageFrame();
  const joinCode = useLive(selectJoinCode, store);
  return (
    <aside className="absolute right-12 bottom-12 flex flex-col items-center gap-1 rounded-card bg-white px-8 py-5 shadow-ledge">
      <p className="text-2xl font-semibold text-ink-2">
        {t("stage.browser.joinCode")}
      </p>
      <p
        className="text-6xl font-bold tracking-widest tabular-nums"
        data-testid="party-join-code"
      >
        {joinCode}
      </p>
      <p className="text-2xl font-semibold">
        {t("stage.browser.pickFromPhone")}
      </p>
    </aside>
  );
}
