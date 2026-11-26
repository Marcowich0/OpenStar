// Auto-fit on a Phone (v1 spec #57, "Auto-fit on a Phone"): a Song's timing
// section in the Songs section offers Fit to the singing only. The button
// starts the guarded `POST /api/songs/{id}/auto-fit` (the Admin PIN pad
// first without an Unlock), becomes a "Listening to the song… N %" pill fed
// by the job's progress, then the Phone downloads the Pitch track, runs the
// fit search with tempo itself (`timing/fitEdits.ts`) and proposes it in the
// desktop's words with Accept and Undo. Accept is a Timing edit through the
// guarded save, naming this Phone so the Stage toasts it; Undo writes
// nothing. After Accept the way back is Restore Original.

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";

import { ApiFailure, api } from "../../api/api";
import { songQuery } from "../../api/queries";
import { fitText } from "../../fit/describeFit";
import { createMatcher } from "../../fit/fit";
import { loadPitchTrack, type PitchTrackLoad } from "../../fit/loadPitchTrack";
import type { PitchTrack } from "../../fit/pitchTrackFile";
import type { PhoneId } from "../../generated/PhoneId";
import type { SongSummary } from "../../generated/SongSummary";
import type { UserMessage } from "../../generated/UserMessage";
import { useGuardedAction } from "../../guarded/useGuardedAction";
import { refusalText, userMessageText } from "../../i18n/serverText";
import { t } from "../../i18n/t";
import { browserStorage } from "../../live/browserLive";
import type { LiveStore } from "../../live/liveStore";
import { phoneId as thisPhoneId } from "../../live/phoneId";
import { useSongPlaying } from "../../live/playingSong";
import { liveStore } from "../../live/useLive";
import { autoFit, type AutoFit } from "../../timing/fitEdits";
import { openTimingModel } from "../../timing/timingModel";
import { Button } from "../../ui/Button";

type Phase =
  /** Nothing running; `outcome` is what the last fit ended with, if shown. */
  | { kind: "idle"; outcome: "saved" | null }
  | { kind: "listening"; percent: number | null }
  | { kind: "proposal"; fit: AutoFit }
  | { kind: "failed"; reason: UserMessage };

const IDLE: Phase = { kind: "idle", outcome: null };

export interface PhoneAutoFitProps {
  song: SongSummary;
  /**
   * Where job updates and the Song playing now come from (the browser's
   * live store by default).
   */
  store?: Pick<LiveStore, "onJobChanged" | "subscribe" | "getSnapshot">;
  /** This browser's Phone id (from local storage by default). */
  phoneId?: PhoneId;
  /** Lays out the button or pill (`control`) and what shows below it. */
  children: (control: ReactNode, details: ReactNode) => ReactNode;
}

export function PhoneAutoFit({
  song,
  store,
  phoneId,
  children,
}: PhoneAutoFitProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const id = { id: String(song.id) };
  // While the Song plays on the Stage it can't be fixed (#225).
  const playing = useSongPlaying(song.id, store);
  // When the fit read the Song, sent with the Accept (#225).
  const openedAtMs = useRef<number | undefined>(undefined);

  const start = useGuardedAction(
    () => api("POST /api/songs/{id}/auto-fit", { params: id }),
    { writesLibrary: true },
  );

  // The fit being accepted, read when the guarded save is sent (again after
  // the PIN pad).
  const accepting = useRef<AutoFit | null>(null);
  const accept = useGuardedAction(
    async () => {
      const fit = accepting.current;
      if (fit?.kind !== "fitted") throw new Error("no fit to accept");
      const operations = [...fit.edit.operations];
      const preview = await api("POST /api/songs/{id}/timing/preview", {
        params: id,
        body: { operations },
      });
      return api("POST /api/songs/{id}/timing", {
        params: id,
        body: {
          base: preview.base,
          operations,
          autoFitFrom: phoneId ?? thisPhoneId(browserStorage()),
          ...(openedAtMs.current === undefined
            ? {}
            : { openedAtMs: openedAtMs.current }),
        },
      });
    },
    { writesLibrary: true },
  );

  async function propose(track: PitchTrack, signal: AbortSignal) {
    try {
      const detail = await queryClient.query(songQuery(song.id));
      openedAtMs.current = detail.loadedAtMs;
      const fit = autoFit(openTimingModel(detail.song), createMatcher(track), {
        tempo: true,
      });
      if (!signal.aborted) setPhase({ kind: "proposal", fit });
    } catch {
      if (!signal.aborted)
        setPhase({ kind: "failed", reason: { code: "serverError" } });
    }
  }

  function run() {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setSaveFailure(null);
    setPhase(IDLE);
    loadPitchTrack(
      song.id,
      {
        onJobChanged: (listener) =>
          (store ?? liveStore()).onJobChanged(listener),
        signal: controller.signal,
        start: async () => {
          const outcome = await start.run();
          if (outcome.kind === "done") return outcome.value;
          // The PIN pad was closed: nothing started.
          controller.abort();
          throw new Error("not started");
        },
      },
      (load: PitchTrackLoad) => {
        if (load.state === "listening")
          setPhase({ kind: "listening", percent: load.percent });
        else if (load.state === "failed")
          setPhase({ kind: "failed", reason: load.reason });
        else void propose(load.track, controller.signal);
      },
    );
  }

  function undo() {
    running.current?.abort();
    setSaveFailure(null);
    setPhase(IDLE);
  }

  function save(fit: AutoFit) {
    accepting.current = fit;
    setSaveFailure(null);
    accept.run().then(
      (outcome) => {
        if (outcome.kind === "done")
          setPhase({ kind: "idle", outcome: "saved" });
      },
      (error: unknown) => {
        setSaveFailure(
          error instanceof ApiFailure && error.failure.kind === "refused"
            ? refusalText(error.failure.error)
            : t("admin.songs.fit.saveFailed"),
        );
      },
    );
  }

  const control =
    phase.kind === "listening" ? (
      <span
        role="status"
        className="rounded-full bg-ink px-4 py-1.5 text-lg font-semibold whitespace-nowrap text-white"
      >
        {phase.percent === null
          ? t("timing.view.listening")
          : t("timing.view.listeningPercent", {
              percent: Math.round(phase.percent),
            })}
      </span>
    ) : phase.kind === "proposal" && phase.fit.kind === "fitted" ? null : (
      <Button
        fill="green"
        isDisabled={start.isDisabled || playing}
        onPress={run}
      >
        {t("admin.songs.fit.run")}
      </Button>
    );

  return (
    <>
      {children(
        control,
        <Details
          phase={phase}
          playing={playing}
          saveFailure={saveFailure}
          onAccept={save}
          onUndo={undo}
        />,
      )}
      {start.dialog}
      {accept.dialog}
    </>
  );
}

function Details({
  phase,
  playing,
  saveFailure,
  onAccept,
  onUndo,
}: {
  phase: Phase;
  playing: boolean;
  saveFailure: string | null;
  onAccept: (fit: AutoFit) => void;
  onUndo: () => void;
}) {
  const reason = playing ? (
    <p className="text-sm text-ink-2">{t("song.playingNow.reason")}</p>
  ) : null;
  switch (phase.kind) {
    case "listening":
      return null;
    case "idle":
      return phase.outcome === "saved" ? (
        <p role="status" className="text-ink-2">
          {t("admin.songs.fit.saved")}
        </p>
      ) : (
        reason
      );
    case "failed":
      return (
        <p role="alert" className="font-semibold text-warn-fg">
          {userMessageText(phase.reason)}
        </p>
      );
    case "proposal": {
      const { fit } = phase;
      if (fit.kind === "alreadyBest")
        return (
          <section aria-label={t("admin.songs.fit.title")}>
            <p className="font-semibold">
              {fitText({ kind: "alreadyBest" })[0]}
            </p>
          </section>
        );
      const [change, share] = fitText(fit.description);
      return (
        <section
          aria-label={t("admin.songs.fit.title")}
          className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-ledge-sm"
        >
          <p className="font-semibold">{change}</p>
          <p>
            {share} {t("admin.songs.fit.check")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              fill="green"
              isDisabled={playing}
              onPress={() => {
                onAccept(fit);
              }}
            >
              {t("admin.songs.fit.accept")}
            </Button>
            <Button onPress={onUndo}>{t("admin.songs.fit.undo")}</Button>
          </div>
          {reason}
          {saveFailure === null ? null : (
            <p role="alert" className="text-sm text-ink-2">
              {saveFailure}
            </p>
          )}
        </section>
      );
    }
  }
}
