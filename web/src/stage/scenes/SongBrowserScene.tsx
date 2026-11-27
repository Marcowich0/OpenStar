// The song browser (v1 spec #55, "Song browser and join card"): the Stage's
// resting scene whenever the Queue is empty. The logo, the big cover
// carousel, the selected Song's info and the breathing Sing!, which adds it
// as a Request from the Stage; the head of the Queue then shows its Line-up.
// Right of the logo, one control group: Search (`/`, #179) and Mute for the
// carousel preview (`M`, `songBrowser/previewMute.tsx`).
// The join card (`../joinCard/`) sits in the bottom-right corner; it holds
// `data-testid="party-join-code"`, which the e2e tests read. While it shows,
// the carousel, the info and Sing! are centred in the room left of its lane,
// and covers that would reach into the lane fade out, so nothing ever runs
// under the QR code. Hidden to its chip, the browser takes the whole width.

import { useState } from "react";

import type { SongId } from "../../generated/SongId";
import type { SongSummary } from "../../generated/SongSummary";
import type { UserMessage } from "../../generated/UserMessage";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { tokenVar } from "../../theme/tokens";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { REFERENCE_WIDTH } from "../frame/referenceFrame";
import { useStageFrame } from "../frame/stageFrameContext";
import { TALL_CARD_WIDTH_PX, useJoinCardHidden } from "../joinCard/JoinCard";
import { StageJoinCard } from "../joinCard/StageJoinCard";
import { StageSongSearch } from "../search/StageSongSearch";
import { useStageSongs } from "../search/songSearch";
import { FULL_REACH, reachWithin } from "./songBrowser/carousel";
import { CAROUSEL_ARROWS, SongCarousel } from "./songBrowser/SongCarousel";
import { SongInfo } from "./songBrowser/SongInfo";
import { PreviewMuteButton, usePreviewMute } from "./songBrowser/previewMute";
import { addStageRequest } from "./songBrowser/stageRequest";
import { useCarouselPreview } from "./songBrowser/useCarouselPreview";

/** Check A/V sync runs or a Calibrate mics run is open. */
const selectHeld = (live: LiveState) =>
  live.avSync || live.calibration !== null;

/** The join card's distance from the frame's right and bottom edges (`right-12`). */
const CARD_MARGIN_PX = 48;

/** The join card's lane: the card, its margin and a gap before the browser. */
export const JOIN_LANE_PX = TALL_CARD_WIDTH_PX + CARD_MARGIN_PX + 32;

/** Neighbours shown while the card shows: none reaches into its lane. */
const LANE_REACH = {
  left: FULL_REACH.left,
  right: reachWithin((REFERENCE_WIDTH - JOIN_LANE_PX) / 2),
};

/** The logo's star, on a 64-unit grid. */
const STAR = "M32 4l8 18 19 2-14 13 4 19-17-10-17 10 4-19L5 24l19-2z";

export function SongBrowserScene() {
  const { store, openSongDetail } = useStageFrame();
  // `/` opens the search, which narrows the carousel (#179).
  const { songs, filters, narrowed } = useStageSongs();
  const [selectedId, setSelectedId] = useState<SongId | null>(null);
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<UserMessage | null>(null);
  const [cardHidden, setCardHidden] = useJoinCardHidden();

  // The selection is kept by Song, so it survives a Library change.
  const found = songs?.findIndex((s) => s.id === selectedId) ?? -1;
  const index = found === -1 ? 0 : found;
  const song: SongSummary | undefined = songs?.[index];
  // The Song shown is the selection, so the Song a search found stays
  // selected once the search is cleared.
  if (song && song.id !== selectedId) setSelectedId(song.id);
  // Previews stop while Check A/V sync runs (#163), so only its click
  // plays, and from the Calibrate mics checklist until its run ends (#170).
  const held = useLive(selectHeld, store);
  // Muted, the carousel plays no preview either.
  const [muted, toggleMuted] = usePreviewMute();
  const detail = useCarouselPreview(song?.id ?? null, held || muted);

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

      {/* Right of the logo, clear of the pill row; the box opens in place of
          the Search button, and the chips row runs under it. */}
      <StageSongSearch
        filters={filters}
        align="start"
        boxClassName="w-[580px]"
        controls={<PreviewMuteButton muted={muted} onToggle={toggleMuted} />}
        className="absolute top-10 right-12 left-[456px] z-[1]"
      />

      <div
        data-testid="song-browser-room"
        className="absolute inset-y-0 left-0 duration-600 motion-safe:transition-[right]"
        style={{ right: cardHidden ? 0 : JOIN_LANE_PX }}
      >
        {songs !== undefined && song === undefined && (
          <p className="absolute inset-x-0 top-[420px] text-center text-6xl font-bold text-ink-2">
            {t(narrowed ? "songs.none" : "stage.browser.empty")}
          </p>
        )}

        {songs && song && (
          <>
            <SongCarousel
              songs={songs}
              selected={index}
              onSelect={select}
              onPick={sing}
              reach={cardHidden ? FULL_REACH : LANE_REACH}
              className="absolute inset-x-0 top-[190px] h-[460px]"
            />
            <SongInfo
              song={song}
              genre={detail?.song.headers.genre ?? null}
              onBest={() => {
                openSongDetail(song);
              }}
              className="absolute inset-x-0 top-[670px]"
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
                // Wrapped to stay in the room, short of the join card's lane.
                <span className="absolute top-1/2 left-full ml-10 w-max max-w-[480px] -translate-y-1/2">
                  <Chip tone="warn" className="whitespace-normal!">
                    {userMessageText(refusal)}
                  </Chip>
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <StageJoinCard
        hidden={cardHidden}
        onHiddenChange={setCardHidden}
        className="absolute right-12 bottom-12"
      />
    </section>
  );
}
