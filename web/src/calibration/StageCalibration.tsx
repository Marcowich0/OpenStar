// Calibrate mics on the Stage (#170), the Setup menu's overlay. It shows
// the run the server holds (`live.calibration`): the checklist of joined
// Phones, each chosen Mic waiting or ready with Go, "stay quiet" while the
// tones play on the Stage's gain chain, and one result row per Mic. Every
// press goes to the server; `StageFrame` opens and closes this overlay as
// the server says the run is open, and Cancel, Done or closing it ends the
// run for every browser (`endCalibration`).

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { profilesQuery } from "../api/queries";
import type { CalibrationRun } from "../generated/CalibrationRun";
import type { MicKey } from "../generated/MicKey";
import { t } from "../i18n/t";
import type { LiveState } from "../live/liveState";
import type { LiveStore } from "../live/liveStore";
import { useLive } from "../live/useLive";
import { useLocalMics } from "../mics/LocalMics";
import { useStageFrame } from "../stage/frame/stageFrameContext";
import { stageAudio } from "../stage/playback/stageAudio";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { calibrationMicName, calibrationResultText } from "./calibrationText";
import { runCalibrationTones } from "./stageCalibration";
import { playToneRun } from "./toneRun";

const selectRun = (live: LiveState) => live.calibration;
const selectParty = (live: LiveState) => live.stage?.party ?? null;

/** A key that changes exactly when the tones of a new set of Mics start. */
function tonesKey(run: CalibrationRun | null): string | null {
  return run?.phase === "tones"
    ? JSON.stringify(run.mics.map((m) => m.mic))
    : null;
}

/** Plays the tones and reports the analysis while the run is in its tones. */
function useCalibrationTones(store: LiveStore, run: CalibrationRun | null) {
  const key = tonesKey(run);
  const { subscribeLocalMicReadings } = useLocalMics();
  useEffect(() => {
    if (key === null) return;
    const mics = JSON.parse(key) as MicKey[];
    const ended = new AbortController();
    void runCalibrationTones({
      store,
      localMicReadings: subscribeLocalMicReadings,
      mics,
      playTones: async (options) => {
        const audio = stageAudio();
        await audio.resume();
        return playToneRun(audio.chain(), options);
      },
      signal: ended.signal,
    });
    return () => {
      ended.abort();
    };
  }, [store, key, subscribeLocalMicReadings]);
}

export function StageCalibration() {
  const { store, closeOverlay } = useStageFrame();
  const run = useLive(selectRun, store);
  const party = useLive(selectParty, store);
  const profiles = useQuery(profilesQuery).data;
  useCalibrationTones(store, run);
  if (!run) return null;
  const nameOf = (mic: MicKey) => calibrationMicName(mic, party, profiles);

  switch (run.phase) {
    case "choosing": {
      const any = run.mics.some((m) => m.chosen);
      return (
        <div className="flex flex-col gap-8">
          <p className="text-3xl text-ink-2">
            {run.mics.length === 0
              ? t("calibration.noMics")
              : t("calibration.checklistHint")}
          </p>
          <ul className="flex flex-col gap-4">
            {run.mics.map((entry) => (
              <li key={JSON.stringify(entry.mic)}>
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
                  className="flex min-h-19 w-full cursor-pointer items-center gap-6 rounded-card bg-white px-8 text-3xl font-semibold shadow-ledge-sm"
                >
                  <span
                    aria-hidden="true"
                    className={`inline-flex size-12 items-center justify-center rounded-full ${
                      entry.chosen ? "bg-green text-white" : "bg-cream"
                    }`}
                  >
                    {entry.chosen && <Icon name="check" className="size-8" />}
                  </span>
                  {nameOf(entry.mic)}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-6">
            <Button onPress={closeOverlay}>{t("calibration.cancel")}</Button>
            <Button
              fill="green"
              isDisabled={!any}
              onPress={() => {
                store.send({ type: "startCalibration" });
              }}
            >
              {t("calibration.continue")}
            </Button>
          </div>
        </div>
      );
    }
    case "waiting": {
      const anyReady = run.mics.some((m) => m.ready);
      return (
        <div className="flex flex-col gap-8">
          <p className="text-3xl text-ink-2">{t("calibration.waitingHint")}</p>
          <ul className="flex flex-col gap-4" data-testid="calibration-mics">
            {run.mics.map((entry) => (
              <li
                key={JSON.stringify(entry.mic)}
                className="flex min-h-19 items-center justify-between rounded-card bg-white px-8 text-3xl"
                data-ready={entry.ready}
              >
                <span className="font-semibold">{nameOf(entry.mic)}</span>
                <span className={entry.ready ? "text-green" : "text-ink-2"}>
                  {entry.ready
                    ? t("calibration.ready")
                    : t("calibration.waiting")}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-6">
            <Button onPress={closeOverlay}>{t("calibration.cancel")}</Button>
            <Button
              fill="green"
              isDisabled={!anyReady}
              onPress={() => {
                store.send({ type: "calibrationGo" });
              }}
            >
              {t("calibration.go")}
            </Button>
          </div>
        </div>
      );
    }
    case "tones":
      return (
        <p className="text-4xl font-semibold" role="status">
          {t("calibration.tones")}
        </p>
      );
    case "results":
      return (
        <div className="flex flex-col gap-8">
          <ul className="flex flex-col gap-4" data-testid="calibration-results">
            {run.mics.map((entry) => (
              <li
                key={JSON.stringify(entry.mic)}
                className="rounded-card bg-white px-8 py-5 text-3xl"
                data-result={entry.outcome?.result ?? "failed"}
              >
                {calibrationResultText(entry, nameOf(entry.mic))}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button fill="green" onPress={closeOverlay}>
              {t("calibration.done")}
            </Button>
          </div>
        </div>
      );
  }
}
