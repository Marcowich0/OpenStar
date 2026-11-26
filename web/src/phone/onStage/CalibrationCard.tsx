// Calibrate mics on a Remote's Stage tab (v1 spec #52, ticket #174). The
// button opens the one run the server holds (the same run as the Stage's
// Setup pill; pressing it while a run is open joins that run). While the run
// is open, whoever opened it, the card follows it: the checklist with
// Continue, each chosen Mic waiting or ready with Go, "stay quiet" during the
// tones, and one result row per Mic. Every press is a request to the server;
// Cancel and Done end the run for every device. No Admin PIN. A Remote whose
// own Phone is chosen is covered by the Calibrating takeover (#173) from
// Continue until the results.

import { useQuery } from "@tanstack/react-query";

import { profilesQuery } from "../../api/queries";
import {
  calibrationMicName,
  calibrationResultText,
} from "../../calibration/StageCalibration";
import type { CalibrationRun } from "../../generated/CalibrationRun";
import type { MicKey } from "../../generated/MicKey";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

const selectRun = (state: LiveState) => state.calibration;
const selectParty = (state: LiveState) => state.stage?.party ?? null;

/** The open Calibrate mics run, or null. */
export function useCalibrationRun(store: LiveStore): CalibrationRun | null {
  return useLive(selectRun, store);
}

export function CalibrateMicsButton({ store }: { store: LiveStore }) {
  return (
    <Button
      fill="white"
      className="w-full"
      onPress={() => {
        store.send({ type: "openCalibration" });
      }}
    >
      {t("stage.overlay.calibrateMics")}
    </Button>
  );
}

const ROW =
  "flex min-h-15 w-full items-center gap-3 rounded-[20px] bg-white/10 p-2.5 px-4 text-lg font-semibold";

const micKey = (mic: MicKey) => JSON.stringify(mic);

export function CalibrationCard({
  store,
  run,
}: {
  store: LiveStore;
  run: CalibrationRun;
}) {
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data;
  const nameOf = (mic: MicKey) => calibrationMicName(mic, party, profiles);
  const end = () => {
    store.send({ type: "endCalibration" });
  };

  return (
    <section
      data-testid="calibration-card"
      className="flex flex-col gap-3 rounded-card bg-ink p-4.5 text-white shadow-ledge"
    >
      <h2 className="text-2xl font-bold">{t("stage.overlay.calibrateMics")}</h2>
      {run.phase === "choosing" && (
        <>
          <p className="text-white/70">
            {run.mics.length === 0
              ? t("calibration.noPhones")
              : t("calibration.checklistHint")}
          </p>
          <ul className="flex flex-col gap-2">
            {run.mics.map((entry) => (
              <li key={micKey(entry.mic)}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={entry.chosen}
                  onClick={() => {
                    store.send({
                      type: "chooseCalibrationMic",
                      mic: entry.mic,
                      chosen: !entry.chosen,
                    });
                  }}
                  className={`${ROW} cursor-pointer text-left outline-none focus-visible:outline-4 focus-visible:outline-yellow`}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${
                      entry.chosen ? "bg-green" : "bg-white/20"
                    }`}
                  >
                    {entry.chosen && <Icon name="check" className="size-6" />}
                  </span>
                  <span className="truncate">{nameOf(entry.mic)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <Button fill="white" className="grow" onPress={end}>
              {t("calibration.cancel")}
            </Button>
            <Button
              fill="green"
              className="grow"
              isDisabled={!run.mics.some((m) => m.chosen)}
              onPress={() => {
                store.send({ type: "startCalibration" });
              }}
            >
              {t("calibration.continue")}
            </Button>
          </div>
        </>
      )}
      {run.phase === "waiting" && (
        <>
          <p className="text-white/70">{t("calibration.waitingHint")}</p>
          <ul className="flex flex-col gap-2">
            {run.mics.map((entry) => (
              <li
                key={micKey(entry.mic)}
                data-ready={entry.ready}
                className={`${ROW} justify-between`}
              >
                <span className="truncate">{nameOf(entry.mic)}</span>
                <span
                  className={
                    entry.ready
                      ? "shrink-0 text-green"
                      : "shrink-0 text-white/70"
                  }
                >
                  {entry.ready
                    ? t("calibration.ready")
                    : t("calibration.waiting")}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <Button fill="white" className="grow" onPress={end}>
              {t("calibration.cancel")}
            </Button>
            <Button
              fill="green"
              className="grow"
              isDisabled={!run.mics.some((m) => m.ready)}
              onPress={() => {
                store.send({ type: "calibrationGo" });
              }}
            >
              {t("calibration.go")}
            </Button>
          </div>
        </>
      )}
      {run.phase === "tones" && (
        <p className="text-xl font-semibold" role="status">
          {t("calibration.tones")}
        </p>
      )}
      {run.phase === "results" && (
        <>
          <ul className="flex flex-col gap-2">
            {run.mics.map((entry) => (
              <li
                key={micKey(entry.mic)}
                data-result={entry.outcome?.result ?? "failed"}
                className={ROW}
              >
                {calibrationResultText(entry, nameOf(entry.mic))}
              </li>
            ))}
          </ul>
          <Button fill="green" className="w-full" onPress={end}>
            {t("calibration.done")}
          </Button>
        </>
      )}
    </section>
  );
}
