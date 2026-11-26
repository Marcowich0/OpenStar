// The sing scene (#164): the head's Song playing on the sing screen, as the
// Stage's playing Song (`stageSong.ts`) runs it. The scene hands it the one
// media element (the video under the lanes, or an `<audio>`), shows the
// pause and the 3-2-1 countdown over the frozen frame, and sends Space or Esc
// as Pause (or Resume while paused) through the server like any Remote.
// The pause menu's look is #217's; the results are #175/#182's. Each
// Player's running Score goes straight into their lane header (#165).

import { useCallback, useEffect, useRef } from "react";

import { t } from "../../../i18n/t";
import type { LiveState } from "../../../live/liveState";
import { useLive } from "../../../live/useLive";
import { Button } from "../../../ui/Button";
import { useStageFrame, useStageKeys } from "../../frame/stageFrameContext";
import { ResumeCountdown } from "../../playback/ResumeCountdown";
import { SingBackdrop } from "../../sing/SingBackdrop";
import { SingScreen } from "../../sing/SingScreen";
import type { StageSong, StageSongView } from "./stageSong";
import { writeLaneScore } from "./laneScore";
import { useStageSong, useStageSongView } from "./useStageSong";

const selectPlaying = (live: LiveState) => live.stage?.party?.playing ?? null;

/** The A/V offset is #161's; until then nothing is drawn behind. */
const noAvOffset = () => 0;

export function SingScene() {
  const { store } = useStageFrame();
  const song = useStageSong(store);
  const view = useStageSongView(song);
  const playing = useLive(selectPlaying, store);

  // Space or Esc: Pause, or Resume while paused, through the server.
  const toggle = () => {
    if (!playing) return true;
    store.send({
      type: "controlSong",
      requestId: playing.requestId,
      control: playing.paused ? "resume" : "pause",
    });
    return true;
  };
  useStageKeys({ " ": toggle, Escape: toggle });

  if (view.kind !== "singing") return <SingMessage view={view} />;
  return <Singing view={view} song={song} />;
}

function SingMessage({
  view,
}: {
  view: Exclude<StageSongView, { kind: "singing" }>;
}) {
  const text =
    view.kind === "loading"
      ? t("stage.sing.loading")
      : view.kind === "failed"
        ? t("stage.sing.failed")
        : t("stage.sing.notPlaying");
  return (
    <section
      data-sing-scene={view.kind}
      className="flex h-full items-center justify-center bg-ink text-white"
    >
      <h1 className="text-7xl font-bold">{text}</h1>
    </section>
  );
}

function Singing({
  view,
  song,
}: {
  view: Extract<StageSongView, { kind: "singing" }>;
  song: StageSong;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      song.onScoring((change) => {
        if (root.current) {
          writeLaneScore(root.current, change.player, change.score.total);
        }
      }),
    [song],
  );
  const attach = useCallback(
    (element: HTMLMediaElement | null) => {
      song.attach(element);
    },
    [song],
  );
  const attachVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      song.attachVideo(element);
    },
    [song],
  );
  const video = view.plan.element === "video";
  // Separate audio and video files (#212): the audio plays, the muted video
  // follows it and shows once its position reached 0.
  const videoRef = video ? attach : view.plan.follow ? attachVideo : undefined;
  return (
    <div
      ref={root}
      data-sing-scene="singing"
      data-ended={view.ended ?? undefined}
      className="h-full"
    >
      <SingScreen
        state={view.state}
        clock={view.clock}
        avOffset={noAvOffset}
        backdrop={
          <SingBackdrop
            media={view.detail.media}
            showVideo={view.videoShown}
            {...(videoRef ? { videoRef } : {})}
          />
        }
      >
        {!video && (
          <audio ref={attach} src={view.plan.url} preload="auto">
            <track kind="captions" />
          </audio>
        )}
        <ResumeCountdown state={view.controls} />
        {view.playFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-10">
            <p className="rounded-card bg-white/90 px-12 py-6 text-5xl text-ink">
              {t("stage.sing.playFailed")}
            </p>
            <div data-stage-default>
              <Button
                onPress={() => {
                  song.retryPlay();
                }}
              >
                {t("stage.sing.play")}
              </Button>
            </div>
          </div>
        )}
      </SingScreen>
    </div>
  );
}
