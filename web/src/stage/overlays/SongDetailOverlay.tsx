// The Song detail overlay (v1 spec #55, "Song browser and join card"): the
// best-score chip opens it. The Song's High score tables (v1 spec #54), the
// top 10 per Voice and Difficulty, with tabs for the Voice (duets only) and
// the Difficulty; Medium shows first. Each row: place, avatar and name in the
// Profile's favourite colour, the Score in tabular figures, and an "older
// timing" mark on a High score sung against an older Note fingerprint.

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { songHighScoresQuery } from "../../api/queries";
import type { Difficulty } from "../../generated/Difficulty";
import type { HighScoreTable } from "../../generated/HighScoreTable";
import { difficultyName } from "../../i18n/seatNames";
import { t } from "../../i18n/t";
import { tokenVar } from "../../theme/tokens";
import { Avatar } from "../../ui/Avatar";
import { useStageFrame } from "../frame/stageFrameContext";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

const TAB =
  "cursor-pointer rounded-full px-7 py-2 text-[28px] font-semibold shadow-ledge-sm";

export function SongDetailOverlay() {
  const { songDetail: song } = useStageFrame();
  const tables = useQuery({
    ...songHighScoresQuery(song?.id ?? 0),
    enabled: song !== null,
  }).data?.tables;
  const [voice, setVoice] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  if (!song) return null;

  const voices = song.duet ? 2 : 1;
  const table = tables?.find(
    (each) => each.voice === voice && each.difficulty === difficulty,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h3 className="truncate text-6xl font-bold">{song.title}</h3>
        <p className="mt-1 truncate text-3xl font-medium text-ink-2">
          {song.artist}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-8">
        {voices > 1 && (
          <Tabs label={t("request.voices")}>
            {[0, 1].map((each) => (
              <TabButton
                key={each}
                selected={voice === each}
                onPick={() => {
                  setVoice(each);
                }}
              >
                {t("request.voice", { voice: each + 1 })}
              </TabButton>
            ))}
          </Tabs>
        )}
        <Tabs label={t("request.difficulties")}>
          {DIFFICULTIES.map((each) => (
            <TabButton
              key={each}
              selected={difficulty === each}
              default={each === "medium"}
              onPick={() => {
                setDifficulty(each);
              }}
            >
              {difficultyName(each)}
            </TabButton>
          ))}
        </Tabs>
      </div>
      <div role="tabpanel" className="min-h-[428px]">
        {tables === undefined ? (
          <p role="status" className="py-10 text-center text-3xl text-ink-2">
            {t("request.loading")}
          </p>
        ) : (
          <Entries table={table} />
        )}
      </div>
    </div>
  );
}

function Tabs({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-3">
      {children}
    </div>
  );
}

function TabButton({
  selected,
  default: isDefault = false,
  onPick,
  children,
}: {
  selected: boolean;
  /** Takes the focus when the overlay opens. */
  default?: boolean;
  onPick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onPick}
      {...(isDefault ? { "data-stage-default": "" } : {})}
      className={`${TAB} ${selected ? "bg-ink-fill text-white" : "bg-surface text-ink"}`}
    >
      {children}
    </button>
  );
}

function Entries({ table }: { table: HighScoreTable | undefined }) {
  if (!table || table.entries.length === 0)
    return (
      <p className="py-10 text-center text-3xl text-mute">
        {t("request.noHighScores")}
      </p>
    );
  return (
    // Up to 5 rows in one column, places 6 to 10 in a second.
    <ol
      className={`grid gap-x-6 gap-y-3 ${table.entries.length > 5 ? "grid-flow-col grid-cols-2 grid-rows-5" : "mx-auto w-[640px]"}`}
    >
      {table.entries.map((entry) => (
        <li
          key={entry.holder.profileId}
          className="flex h-[76px] items-center gap-4 rounded-card-sm bg-surface px-6 shadow-ledge-sm"
        >
          <span className="w-10 text-center text-[32px] font-bold tabular-nums">
            {entry.place}
          </span>
          <Avatar
            name={entry.holder.name}
            avatar={entry.holder.avatar}
            colour={entry.holder.favouriteColour}
            size={52}
          />
          <span
            className="min-w-0 grow truncate text-[32px] font-bold"
            style={{ color: tokenVar(entry.holder.favouriteColour) }}
          >
            {entry.holder.name}
          </span>
          {entry.olderTiming && (
            <span className="shrink-0 rounded-full bg-cream-2 px-3.5 py-0.5 text-xl font-semibold text-ink-2">
              {t("request.olderTiming")}
            </span>
          )}
          <span className="text-[34px] font-bold tabular-nums">
            {t("request.total", { total: entry.total })}
          </span>
        </li>
      ))}
    </ol>
  );
}
