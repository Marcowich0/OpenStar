// Placeholder for the scene a later ticket builds: the results (#182, its
// look from #55). It replaces its entry in `frame/sceneComponents.tsx`.
// Until then it lists the results the Party shows (#175's data): each
// Player's place, name and total, ranked.

import type { PlayerResult } from "../../generated/PlayerResult";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { useStageFrame } from "../frame/stageFrameContext";

const HEADING = "text-8xl font-bold";
const CENTRED = "flex h-full flex-col items-center justify-center gap-10";

const selectResults = (live: LiveState) => live.stage?.party?.results ?? null;

export function ResultsScene() {
  const { store } = useStageFrame();
  const results = useLive(selectResults, store);
  return (
    <section className={CENTRED}>
      <h1 className={HEADING}>{t("stage.results.title")}</h1>
      {results && <ResultsList players={results.players} />}
    </section>
  );
}

export function ResultsList({ players }: { players: readonly PlayerResult[] }) {
  return (
    <ol data-testid="results-players" className="text-5xl tabular-nums">
      {players.map((player) => (
        <li key={player.memberId}>
          {t("stage.results.player", {
            place: player.place,
            name: player.name,
            total: player.total,
          })}
        </li>
      ))}
    </ol>
  );
}
