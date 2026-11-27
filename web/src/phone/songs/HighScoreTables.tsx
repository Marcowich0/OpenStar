// The Request sheet's High score tables (v1 spec #49 and #54): the top 10
// per Voice and Difficulty, with tabs for the Voice (duets only) and the
// Difficulty. Medium shows first.

import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";

import type { Difficulty } from "../../generated/Difficulty";
import type { HighScoreTable } from "../../generated/HighScoreTable";
import { difficultyName } from "../../i18n/seatNames";
import { t } from "../../i18n/t";
import { Avatar } from "../../ui/Avatar";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

const TAB =
  "cursor-pointer rounded-full px-3.5 py-1 text-sm font-semibold text-ink-2 outline-none data-focus-visible:outline-4 data-focus-visible:outline-yellow data-selected:bg-ink-fill data-selected:text-white";
const TAB_LIST = "flex gap-1.5";

export function HighScoreTables({
  tables,
  voices,
}: {
  tables: readonly HighScoreTable[];
  /** How many Voices the Song has: 2 for a duet. */
  voices: number;
}) {
  if (voices < 2) return <DifficultyTabs tables={tables} voice={0} />;
  const ids = Array.from({ length: voices }, (_, voice) => voice);
  return (
    <Tabs defaultSelectedKey="voice-0" className="flex flex-col gap-2">
      <TabList aria-label={t("request.voices")} className={TAB_LIST}>
        {ids.map((voice) => (
          <Tab key={voice} id={`voice-${String(voice)}`} className={TAB}>
            {t("request.voice", { voice: voice + 1 })}
          </Tab>
        ))}
      </TabList>
      {ids.map((voice) => (
        <TabPanel
          key={voice}
          id={`voice-${String(voice)}`}
          className="outline-none"
        >
          <DifficultyTabs tables={tables} voice={voice} />
        </TabPanel>
      ))}
    </Tabs>
  );
}

function DifficultyTabs({
  tables,
  voice,
}: {
  tables: readonly HighScoreTable[];
  voice: number;
}) {
  return (
    <Tabs defaultSelectedKey="medium" className="flex flex-col gap-2">
      <TabList aria-label={t("request.difficulties")} className={TAB_LIST}>
        {DIFFICULTIES.map((difficulty) => (
          <Tab key={difficulty} id={difficulty} className={TAB}>
            {difficultyName(difficulty)}
          </Tab>
        ))}
      </TabList>
      {DIFFICULTIES.map((difficulty) => (
        <TabPanel key={difficulty} id={difficulty} className="outline-none">
          <Entries
            table={tables.find(
              (table) =>
                table.voice === voice && table.difficulty === difficulty,
            )}
          />
        </TabPanel>
      ))}
    </Tabs>
  );
}

function Entries({ table }: { table: HighScoreTable | undefined }) {
  if (!table || table.entries.length === 0)
    return (
      <p className="py-2 text-center text-sm text-mute">
        {t("request.noHighScores")}
      </p>
    );
  return (
    <ol className="flex flex-col gap-1.5">
      {table.entries.map((entry) => (
        <li
          key={entry.holder.profileId}
          className="flex items-center gap-2.5 rounded-card-sm bg-surface px-3 py-1.5 shadow-ledge-sm"
        >
          <span className="w-5 text-center font-bold tabular-nums">
            {entry.place}
          </span>
          <span aria-hidden="true">
            <Avatar
              name={entry.holder.name}
              avatar={entry.holder.avatar}
              colour={entry.holder.favouriteColour}
              size={28}
            />
          </span>
          <span className="min-w-0 grow truncate font-semibold">
            {entry.holder.name}
          </span>
          {entry.olderTiming && (
            <span className="rounded-full bg-cream-2 px-2 text-xs font-semibold text-ink-2">
              {t("request.olderTiming")}
            </span>
          )}
          <span className="font-bold tabular-nums">
            {t("request.total", { total: entry.total })}
          </span>
        </li>
      ))}
    </ol>
  );
}
