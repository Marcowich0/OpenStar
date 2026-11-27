// Below the carousel: the selected Song's title, artist and chips (Duet,
// genre, year, length, best score). The block pops in on every change.
// The best-score chip is a button: Enter (or a click) opens the Song detail.

import type { SongSummary } from "../../../generated/SongSummary";
import { t } from "../../../i18n/t";
import { songLength } from "../../../phone/songs/SongTags";
import { Chip, type ChipTone } from "../../../ui/Chip";

export interface SongInfoProps {
  song: SongSummary;
  /** `#GENRE` as written, from the Song's detail; `null` while unknown. */
  genre: string | null;
  /** Enter or a click on the best-score chip. */
  onBest: () => void;
  className?: string;
}

const CHIP_TEXT = "px-[22px] py-2 text-[28px]";

export function SongInfo({
  song,
  genre,
  onBest,
  className = "",
}: SongInfoProps) {
  const chips: { key: string; tone: ChipTone; text: string }[] = [];
  if (song.duet)
    chips.push({ key: "duet", tone: "duet", text: t("chip.duet") });
  if (genre) chips.push({ key: "genre", tone: "plain", text: genre });
  if (song.year !== null)
    chips.push({ key: "year", tone: "plain", text: String(song.year) });
  if (song.lengthSeconds !== null)
    chips.push({
      key: "length",
      tone: "plain",
      text: songLength(song.lengthSeconds),
    });
  if (song.topHighScore)
    chips.push({
      key: "best",
      tone: "best",
      text: t("stage.browser.best", {
        total: song.topHighScore.total,
        name: song.topHighScore.holder.name,
      }),
    });

  return (
    <div
      key={song.id}
      data-testid="song-info"
      className={`animate-pop-in text-center ${className}`}
    >
      <h1 className="truncate px-16 text-[92px] leading-none font-bold">
        {song.title}
      </h1>
      <p className="mt-2.5 mb-[18px] truncate px-16 text-[40px] font-medium text-ink-2">
        {song.artist}
      </p>
      <ul className="flex justify-center gap-3.5">
        {chips.map((chip) => (
          <li key={chip.key}>
            {chip.key === "best" ? (
              <button
                type="button"
                onClick={onBest}
                className="cursor-pointer rounded-full"
              >
                <Chip tone={chip.tone} className={CHIP_TEXT}>
                  {chip.text}
                </Chip>
              </button>
            ) : (
              <Chip tone={chip.tone} className={CHIP_TEXT}>
                {chip.text}
              </Chip>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
