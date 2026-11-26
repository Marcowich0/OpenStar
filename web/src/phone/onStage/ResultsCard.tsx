// The Stage tab's card while the results show (v1 spec #49, "Stage tab"):
// "Results on the Stage", the Song title and "Next Song", or "Done" when the
// Queue holds nothing more. Either one closes the results for everyone, as
// the Stage's own Next does. `children` is this Phone's own Player's result.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { songQuery } from "../../api/queries";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { Button } from "../../ui/Button";
import type { StageCard } from "../remoteFrame";

export function ResultsCard({
  store,
  results,
  children,
}: {
  store: LiveStore;
  results: Extract<StageCard, { kind: "results" }>;
  children?: ReactNode;
}) {
  const song = useQuery(songQuery(results.songId)).data;
  return (
    <section
      data-testid="results-card"
      className="flex flex-col gap-1 rounded-card bg-ink p-4.5 text-white shadow-ledge"
    >
      <p className="text-sm font-semibold text-white/70">
        {t("stageTab.results")}
      </p>
      <h2 className="truncate text-2xl font-bold">
        {song?.song.headers.title ?? ""}
      </h2>
      {children}
      <Button
        fill="white"
        className="mt-3 w-full"
        onPress={() => {
          store.send({ type: "closeResults" });
        }}
      >
        {t(results.queueEmpty ? "stageTab.done" : "stageTab.nextSong")}
      </Button>
    </section>
  );
}

/** The Stage tab's card with an empty Queue. */
export function EmptyQueueCard() {
  return (
    <section className="flex flex-col gap-1 rounded-card bg-ink p-4.5 text-white shadow-ledge">
      <h2 className="text-2xl font-bold">{t("stageTab.waiting")}</h2>
      <p className="text-white/70">{t("stageTab.queueEmpty")}</p>
    </section>
  );
}
