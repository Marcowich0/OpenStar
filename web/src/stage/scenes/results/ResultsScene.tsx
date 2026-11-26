// The results scene (v1 spec #55, "Results screen and Rank titles"): the end
// of a Song as a podium. One rising bar per Player in their Party colour,
// ranked by total, with the total, the Rank title and the avatar above it and
// where the points came from under it; a sticker for a new High score, a
// hatched bar and an "unfinished" stamp for a Player who did not finish; and
// "Next: <Song>" (or Done) leading on. No Join code here.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { songsQuery } from "../../../api/queries";
import type { SongResults } from "../../../generated/SongResults";
import type { SongSummary } from "../../../generated/SongSummary";
import { rankTitle } from "../../../i18n/rankTitles";
import { difficultyName } from "../../../i18n/seatNames";
import { t } from "../../../i18n/t";
import type { LiveState } from "../../../live/liveState";
import { useLive } from "../../../live/useLive";
import { tokenVar } from "../../../theme/tokens";
import { Avatar } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { Score } from "../../../ui/Score";
import { useStageFrame } from "../../frame/stageFrameContext";
import { resultsView, type BarView } from "./resultsView";
import "./results.css";

const selectParty = (live: LiveState) => live.stage?.party ?? null;

export function ResultsScene() {
  const { store } = useStageFrame();
  const party = useLive(selectParty, store);
  const songs = useQuery(songsQuery()).data?.songs;
  const [closing, setClosing] = useState(false);
  const results = party?.results;
  if (!party || !results) return null;
  const songOf = (id: number | undefined): SongSummary | undefined =>
    songs?.find((s) => s.id === id);
  // The sung Request has left the Queue: its first Request is the next one.
  const next = party.queue[0];
  return (
    <ResultsBody
      results={results}
      song={songOf(results.songId) ?? null}
      next={next ? (songOf(next.songId)?.title ?? "") : null}
      onNext={() => {
        if (closing) return;
        setClosing(true);
        store.send({ type: "closeResults" });
      }}
    />
  );
}

export interface ResultsBodyProps {
  results: SongResults;
  /** The sung Song, while the Library knows it. */
  song: Pick<SongSummary, "title" | "artist"> | null;
  /** The next Request's Song title, or `null` with an empty Queue (Done). */
  next: string | null;
  onNext: () => void;
}

/** The results screen in the 1920 × 1080 reference frame. */
export function ResultsBody({ results, song, next, onNext }: ResultsBodyProps) {
  const view = resultsView(results.players);
  const duet = results.players.some((p) => p.voice !== null);
  return (
    <section className="relative h-full">
      <header className="absolute inset-x-0 top-[44px] text-center">
        <h1 className="text-[72px] leading-none font-bold">
          {song?.title ?? ""}
        </h1>
        <p
          className={`mt-2 text-[30px] ${view.endedEarly ? "font-semibold text-warn-fg" : "text-ink-2"}`}
        >
          {view.endedEarly ? t("stage.results.endedEarly") : song?.artist}
        </p>
      </header>

      <Legend />

      <ol
        data-testid="results-players"
        aria-label={t("stage.results.players")}
        className="absolute inset-x-[120px] top-[220px] bottom-[220px] flex items-end justify-center gap-[50px]"
      >
        {view.bars.map((bar) => (
          <Bar key={bar.player.memberId} bar={bar} duet={duet} />
        ))}
      </ol>

      <div data-stage-default className="absolute right-[60px] bottom-[60px]">
        <Button fill="green" onPress={onNext}>
          {next === null
            ? t("stage.results.done")
            : t("stage.results.next", { song: next })}
        </Button>
      </div>
    </section>
  );
}

function Legend() {
  const swatch = "inline-block h-5 w-[26px] rounded-[6px] mr-2.5 align-[-3px]";
  return (
    <ul
      aria-label={t("stage.results.legend")}
      className="absolute top-[60px] left-[60px] flex flex-col gap-2 text-xl font-semibold text-ink-2"
    >
      <li>
        <span aria-hidden="true" className={`${swatch} bg-slate`} />
        {t("stage.results.notes")}
      </li>
      <li>
        <span aria-hidden="true" className={`${swatch} bg-yellow`} />
        {t("stage.results.golden")}
      </li>
      <li>
        <span aria-hidden="true" className={`${swatch} bg-slate`}>
          <span className="block size-full rounded-[6px] bg-white/45" />
        </span>
        {t("stage.results.lineBonus")}
      </li>
    </ul>
  );
}

// "Bo · Hard · Guest": each part after the first gets its dot from CSS.
const DETAIL = "before:mx-2 before:content-['·'] first:before:content-none";

function Bar({ bar, duet }: { bar: BarView; duet: boolean }) {
  const { player, parts } = bar;
  const colour = tokenVar(player.colour);
  return (
    <li className="relative flex h-full w-[250px] flex-col items-center justify-end">
      <Score
        value={player.total}
        className="mb-1.5 text-[64px] leading-none font-bold"
      />
      <span className="mb-3 rounded-full bg-ink px-[18px] py-1.5 text-2xl font-bold whitespace-nowrap text-white">
        {rankTitle(player.rankTitleBand)}
      </span>
      <Avatar
        name={player.name}
        avatar={player.avatar}
        colour={player.colour}
        size={120}
        className="relative z-[2] -mb-[30px]"
      />

      <div
        className="relative w-full"
        style={{ height: `${String(bar.height * 62)}%` }}
      >
        <div
          className="results-bar absolute inset-0 flex flex-col-reverse overflow-hidden rounded-[40px_40px_18px_18px] border-6 border-white shadow-ledge-lg"
          style={{
            backgroundColor: colour,
            animationDelay: `${String(bar.growDelayMs)}ms`,
          }}
        >
          <i className="block" style={{ flexGrow: parts.notes }} />
          <i className="block bg-yellow" style={{ flexGrow: parts.golden }} />
          <i
            className="block bg-white/45"
            style={{ flexGrow: parts.lineBonus }}
          />
          {bar.hatched && <i className="results-hatch absolute inset-0" />}
          <span className="results-place absolute inset-x-0 bottom-5 text-center text-[72px] leading-none font-bold">
            <span className="sr-only">
              {t("stage.results.place", { place: player.place })}
            </span>
            <span aria-hidden="true">{player.place}</span>
          </span>
        </div>

        {bar.hatched && (
          <span className="absolute bottom-[40%] left-1/2 z-[3] -translate-x-1/2 -rotate-12 rounded-[14px] border-4 border-warn-fg bg-white px-3.5 py-1.5 text-2xl font-bold whitespace-nowrap text-warn-fg">
            {t("stage.results.unfinished")}
          </span>
        )}
        {bar.sticker && (
          <span
            className="results-sticker absolute -top-[70px] -right-[60px] z-[3] flex size-[120px] rotate-12 animate-pop-in items-center justify-center rounded-full bg-yellow p-3 text-center text-xl leading-[1.05] font-bold shadow-ledge-yellow"
            style={{ animationDelay: `${String(bar.stickerDelayMs)}ms` }}
          >
            {t("stage.results.newHighScore")}
          </span>
        )}

        <div className="absolute -inset-x-5 top-[calc(100%+24px)] text-center text-[22px] leading-[1.3] font-medium text-ink-2">
          <p>
            <b className={`font-bold text-ink ${DETAIL}`}>{player.name}</b>
            {duet && player.voice !== null && (
              <span className={DETAIL}>
                {t("stage.results.voice", { voice: player.voice + 1 })}
              </span>
            )}
            <span className={DETAIL}>{difficultyName(player.difficulty)}</span>
            {player.player.kind === "guest" && (
              <span className={DETAIL}>{t("stage.results.guest")}</span>
            )}
          </p>
          <p className="tabular-nums">
            {t("stage.results.parts", {
              notes: String(player.notes),
              golden: String(player.golden),
              lineBonus: String(player.lineBonus),
            })}
          </p>
          {player.micLost && (
            <p className="font-semibold text-warn-fg">
              {t("stage.results.micLost")}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
