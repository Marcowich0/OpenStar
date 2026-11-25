// `/stage/playback?song=<id>`: the minimal Stage view that plays a Library
// Song (#155) until the sing scene plays the head's Request (#164). It plays
// the Song through the Stage's AudioContext and gain chain on the sing
// screen, and shows a live `songTime()` readout and the largest frame-to-frame
// jitter, for checking the clock in real Chromium (144 Hz, #53).

import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { songQuery } from "../../api/queries";
import type { SongDetail } from "../../generated/SongDetail";
import { t } from "../../i18n/t";
import {
  createMediaPlayback,
  type SongEnding,
} from "../../playback/mediaPlayback";
import { playbackPlan } from "../../playback/playbackPlan";
import { PALETTE_KEYS } from "../../theme/tokens";
import { Button } from "../../ui/Button";
import { singVoices, type SingState } from "../sing/frame";
import { SingBackdrop } from "../sing/SingBackdrop";
import { SingScreen } from "../sing/SingScreen";
import { stageAudio } from "./stageAudio";

export function PlaybackCheck() {
  const { song } = useSearch({ from: "/stage/playback" });
  const detail = useQuery({
    ...songQuery(song ?? -1),
    enabled: song !== undefined,
  });
  if (detail.data) return <PlaybackView detail={detail.data} />;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink text-5xl text-white">
      {detail.isError || song === undefined
        ? t("stage.playback.noSong")
        : t("stage.playback.loading")}
    </main>
  );
}

/** The chain, made on first use (the Stage's AudioContext with it). */
const chain = {
  connectMedia: (element: HTMLMediaElement) =>
    stageAudio().chain().connectMedia(element),
  setSongLoudness: (lufs: number | null) => {
    stageAudio().chain().setSongLoudness(lufs);
  },
};

/** How many frames the jitter readout looks back over. */
const JITTER_FRAMES = 240;

function PlaybackView({ detail }: { detail: SongDetail }) {
  const plan = useMemo(() => playbackPlan(detail), [detail]);
  const state = useMemo<SingState>(() => {
    const voices = singVoices(detail.song);
    return {
      grid: detail.song.headers,
      voices,
      lanes: voices.map((_, voice) => ({
        colour: PALETTE_KEYS[(voice * 3) % PALETTE_KEYS.length] ?? "cherry",
        voice,
      })),
      lengthSeconds: detail.lengthSeconds,
    };
  }, [detail]);

  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const [ending, setEnding] = useState<SongEnding | null>(null);
  const [failed, setFailed] = useState(false);
  const playback = useMemo(
    () =>
      element &&
      createMediaPlayback({
        element,
        plan,
        chain,
        outputLatencyMs: () => stageAudio().outputLatencyMs(),
        onEnded: setEnding,
      }),
    [element, plan],
  );
  useEffect(
    () => () => {
      playback?.dispose();
    },
    [playback],
  );

  // The readout: Song time and the largest frame-to-frame jitter (how far a
  // frame's Song time step strays from the Stage time step).
  const readout = useRef<HTMLSpanElement>(null);
  const jitter = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!playback) return;
    const steps: number[] = [];
    let last: { stage: number; song: number } | null = null;
    let handle = requestAnimationFrame(function onFrame() {
      const stage = performance.now();
      const song = playback.clock.songTime();
      if (last && playback.clock.playing) {
        steps.push(Math.abs(song - last.song - (stage - last.stage) / 1000));
        if (steps.length > JITTER_FRAMES) steps.shift();
      }
      last = { stage, song };
      const shown = readout.current;
      if (shown) {
        shown.textContent = t("stage.playback.songTime", { seconds: song });
        shown.dataset.songTime = String(song);
        shown.dataset.audioContext = stageAudio().context().state;
      }
      if (jitter.current && steps.length > 0) {
        const ms = Math.max(...steps) * 1000;
        jitter.current.textContent = t("stage.playback.jitter", { ms });
        jitter.current.dataset.jitterMs = String(ms);
      }
      handle = requestAnimationFrame(onFrame);
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [playback]);

  const video = plan.element === "video";
  const frozen = useMemo(() => ({ songTime: () => plan.startSeconds }), [plan]);

  return (
    <SingScreen
      state={state}
      clock={playback?.clock ?? frozen}
      avOffset={() => 0}
      backdrop={
        <SingBackdrop
          media={detail.media}
          showVideo={video}
          {...(video ? { videoRef: setElement } : {})}
        />
      }
    >
      {!video && (
        <audio ref={setElement} src={plan.url} preload="auto">
          <track kind="captions" />
        </audio>
      )}
      <div className="absolute right-8 bottom-8 flex items-center gap-6 rounded-card bg-white/90 px-8 py-4 text-3xl text-ink tabular-nums">
        <span>{detail.song.headers.title}</span>
        <span ref={readout} data-testid="song-time" data-song-time="0" />
        <span ref={jitter} />
        {ending !== null && (
          <span data-testid="song-ended" data-ending={ending}>
            {t("stage.playback.ended")}
          </span>
        )}
        {failed && <span>{t("stage.playback.failed")}</span>}
        <Button
          isDisabled={playback === null}
          onPress={() => {
            if (!playback) return;
            setEnding(null);
            setFailed(false);
            stageAudio()
              .resume()
              .then(() => playback.start())
              .catch(() => {
                setFailed(true);
              });
          }}
        >
          {t("stage.playback.play")}
        </Button>
      </div>
    </SingScreen>
  );
}
