// The Songs overlay (v1 spec #55, "Overlays: Songs, Queue and People"): the
// song browser's cover carousel in an overlay, so the host adds Songs without
// leaving the current scene. Enter (or a click) on the selected cover adds it
// as a Request from the Stage and confirms it here ("Added Africa"); the
// overlay stays open for the next one. It plays no preview: the scene under
// it may be a Line-up. The song browser's search (#179) narrows this
// carousel too, once it exists.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { songsQuery } from "../../api/queries";
import type { SongId } from "../../generated/SongId";
import type { SongSummary } from "../../generated/SongSummary";
import type { UserMessage } from "../../generated/UserMessage";
import { userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { useStageFrame } from "../frame/stageFrameContext";
import { SongCarousel } from "../scenes/songBrowser/SongCarousel";
import { addStageRequest } from "../scenes/songBrowser/stageRequest";

/** What the line under the carousel says after Enter. */
type Outcome =
  | { kind: "added"; title: string }
  | { kind: "refused"; reason: UserMessage | null };

export function SongsOverlay() {
  const { store } = useStageFrame();
  const songs = useQuery(songsQuery()).data?.songs;
  const [selectedId, setSelectedId] = useState<SongId | null>(null);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The selection is kept by Song, so it survives a Library change.
  const found = songs?.findIndex((s) => s.id === selectedId) ?? -1;
  const index = found === -1 ? 0 : found;
  const song: SongSummary | undefined = songs?.[index];

  const select = (next: number) => {
    const nextSong = songs?.[next];
    if (!nextSong) return;
    setSelectedId(nextSong.id);
    setOutcome(null);
  };

  const add = (picked: SongSummary) => {
    if (picked.preparing || adding) return;
    setAdding(true);
    setOutcome(null);
    void addStageRequest(store, picked.id).then((result) => {
      setAdding(false);
      setOutcome(
        result.ok
          ? { kind: "added", title: picked.title }
          : { kind: "refused", reason: result.reason },
      );
    });
  };

  if (songs !== undefined && song === undefined) {
    return (
      <p className="py-10 text-center text-4xl font-bold text-ink-2">
        {t("stage.browser.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {songs && song && (
        <>
          <div className="relative h-[460px] w-full overflow-hidden">
            <SongCarousel
              songs={songs}
              selected={index}
              onSelect={select}
              onPick={add}
              className="size-full"
            />
          </div>
          <h3
            data-testid="songs-overlay-title"
            className="max-w-full truncate text-5xl font-bold"
          >
            {song.title}
          </h3>
          <p className="max-w-full truncate text-3xl text-ink-2">
            {song.artist}
          </p>
        </>
      )}
      <p role="status" className="min-h-12 text-3xl font-semibold">
        {outcome?.kind === "added" && (
          <span className="text-green-ledge">
            {t("stage.songs.added", { song: outcome.title })}
          </span>
        )}
        {outcome?.kind === "refused" && (
          <span className="text-warn-fg">
            {outcome.reason === null
              ? t("request.noAnswer")
              : userMessageText(outcome.reason)}
          </span>
        )}
      </p>
    </div>
  );
}
