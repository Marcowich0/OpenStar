/**
 * The Stage's playing Song (#164): acts on every `controlSong` the server
 * sends the Stage, from the Stage itself or any Remote.
 *
 * - **Start** loads the head's Song, builds the sing screen's state and the
 *   Mic-to-Player map once from the Line-up fixed at Start (`singSetup.ts`),
 *   starts the live scoring session (#165, `scoring/liveScoring.ts`) and the
 *   Pitch router, and plays from `#START` as soon as the sing scene hands
 *   over its media element (`attach`). While the Song plays, one animation
 *   frame loop ticks the scoring session; each Player's running Score goes
 *   into their lane (`onScoring` lets the scene write the header without a
 *   React render). At each Line end each seat's running total goes to the
 *   server (`reportLineScore`), which passes it to that seat's Phone (#167).
 * - **Pause, Resume, Restart** go to the Song controls (#158: freeze, 3-2-1,
 *   seek to `#START` with the buffers cleared and the scoring reset).
 * - **End** stops the Song. A Song that plays out or is ended reports its
 *   round once (#175): `POST /api/rounds` with each seat's Score, sent again
 *   while the answer is lost (the server stores one outcome per Request
 *   once). The server then shows the results to the Party. The round stays
 *   in `lastRound()`.
 * - **Skip** stops the Song and reports the skipped round once
 *   (`POST /api/rounds`, no Scores); the server has already moved the Party on.
 * - **Game sounds** (#262): `go` when the Song starts playing (also after a
 *   Restart), a `countdown` blip for each number of the resume countdown and
 *   `go` when it plays on, `linePerfect` when a Line ends Perfect!, and
 *   `goldenHit` while a seat's golden Notes score, at most once per 250 ms
 *   per seat. The sound engine silences them at a UI sounds level of 0, and
 *   the last two with Effects off.
 *
 * A Stage that drops (the socket reconnects, another browser takes over) or a
 * Party that stops playing the Song stops it and reports nothing. A Stage
 * that never heard Start for the Song playing (it was reloaded mid-Song)
 * plays nothing.
 *
 * It lives outside React, created with the Stage's store, so it hears the
 * `controlSong` that follows the `partyChanged` switching to the sing scene
 * even before that scene has mounted.
 */

import { createSongClock, type SongClock } from "../../../clock/songClock";
import type { Profile } from "../../../generated/Profile";
import type { RequestId } from "../../../generated/RequestId";
import type { RoundOutcome } from "../../../generated/RoundOutcome";
import type { SongDetail } from "../../../generated/SongDetail";
import type { SongId } from "../../../generated/SongId";
import type { LiveStore, SongControlMessage } from "../../../live/liveStore";
import type {
  MediaPlayback,
  FollowingVideoElement,
  PlaybackElement,
  PositionReport,
  SongEnding,
} from "../../../playback/mediaPlayback";
import {
  playbackPlan,
  type PlaybackPlan,
} from "../../../playback/playbackPlan";
import type { MicKey } from "../../../generated/MicKey";
import type { PitchBuffer } from "../../../pitch/pitchBuffer";
import type { PitchMic, PitchRouter } from "../../../pitch/pitchRouter";
import {
  createLiveScoring,
  type LiveScoring,
  type LiveScoringChange,
  type LiveScoringOutcome,
} from "../../../scoring/liveScoring";
import type { SingState } from "../../sing/frame";
import { lineEnded } from "../../sing/lineRating";
import {
  createSongControls,
  type SongControls,
  type SongControlsOptions,
  type SongControlsState,
} from "../../playback/songControls";
import { ApiFailure } from "../../../api/api";
import { SCORING } from "../../../scoring/constants";
import { createGoldenHits } from "../../sound/goldenHits";
import { silentSounds, type UiSounds } from "../../sound/uiSounds";
import { stageOptions } from "../../../stageOptions/stageOptions";
import { roundOutcome } from "./roundOutcome";
import { singSetup, type SingSetup } from "./singSetup";

/** How often a played or ended round's outcome is sent when the answer is lost. */
const REPORT_ATTEMPTS = 6;
/** The wait before the first resend; it doubles each time. */
const REPORT_RETRY_MS = 500;

/** A lost answer (no answer, or the server failed): send the same outcome again. */
function worthRetrying(error: unknown): boolean {
  if (!(error instanceof ApiFailure)) return false;
  const failure = error.failure;
  return failure.kind === "network" || failure.status >= 500;
}

/** What the sing scene shows. */
export type StageSongView =
  /** No Song this Stage started is playing. */
  | { kind: "idle" }
  | { kind: "loading"; requestId: RequestId }
  /** The Song could not be loaded. */
  | { kind: "failed"; requestId: RequestId }
  | {
      kind: "singing";
      requestId: RequestId;
      detail: SongDetail;
      plan: PlaybackPlan;
      state: SingState;
      clock: SongClock;
      controls: SongControlsState;
      /** The browser refused to play; `retryPlay()` from a user gesture. */
      playFailed: boolean;
      /** Set once the Song played out or was ended. */
      ended: SongEnding | null;
      /**
       * The video shows over the background: always for a video in the audio
       * file; a separate video file (#212) once its position reached 0.
       */
      videoShown: boolean;
    };

/** A Song that played out or was ended, for the results flow (#175). */
export interface StageRound {
  requestId: RequestId;
  detail: SongDetail;
  setup: SingSetup;
  /** Each Player's readings, as they were when the Song ended. */
  buffers: readonly PitchBuffer[];
  /**
   * Each Player's live-scored outcome (in `setup.players` order) and the
   * Song's Note fingerprint: what the Score records need.
   */
  scoring: LiveScoringOutcome;
  /** When the Song last started from its beginning (after the last Restart), Unix ms. */
  startedAtMs: number;
  ended: SongEnding;
  partyId: string;
}

export interface StageSongOptions {
  store: Pick<
    LiveStore,
    "getSnapshot" | "subscribe" | "send" | "onSongControl" | "showStageToast"
  >;
  loadSong: (id: SongId) => Promise<SongDetail>;
  /** The Profiles, for the lane headers' names and avatars. */
  profiles: () => readonly Profile[] | undefined;
  pitch: Pick<PitchRouter, "start" | "stop">;
  createPlayback: (args: {
    element: PlaybackElement;
    /** The muted video following the audio, for a plan with `follow` (#212). */
    video: FollowingVideoElement | null;
    plan: PlaybackPlan;
    clock: SongClock;
    onEnded: (how: SongEnding) => void;
    /** Where the Song stands, on start, pause, resume, Restart and end only (#159). */
    onReport: (report: PositionReport) => void;
    /** The following video shows (it reached position 0), or not any more. */
    onVideoShown: (shown: boolean) => void;
  }) => Pick<
    MediaPlayback,
    "start" | "pause" | "resume" | "restart" | "end" | "dispose"
  >;
  /** Resumes the Stage's AudioContext before playing. */
  resumeAudio: () => Promise<void>;
  /** Stores a round's outcome (`POST /api/rounds`). */
  postRound: (outcome: RoundOutcome) => Promise<unknown>;
  /** Waits before sending an outcome again (`setTimeout`). */
  wait?: (ms: number) => Promise<void>;
  /** Wall-clock now, Unix ms (`Date.now`). */
  now?: () => number;
  /** The countdown's timer (`SongControlsOptions.schedule`). */
  schedule?: SongControlsOptions["schedule"];
  /**
   * The resume countdown's first number, read at each resume
   * (`SongControlsOptions.countdownFrom`; the Stage options' by default).
   */
  countdownFrom?: () => number;
  /** The Stage clock in ms (`performance.now`), for the Song clock and lost Mics. */
  stageNow?: () => number;
  /** The animation frame loop that ticks the scoring (`requestAnimationFrame`). */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /**
   * The Mic each seated Mic's readings reach the Pitch router as
   * (`SingSetupInput.micIdFor`); by default `pitchMicFor`.
   */
  micIdFor?: (mic: MicKey) => PitchMic | null;
  /** The game sounds the sing screen plays (the Stage's UI sounds); none by default. */
  sounds?: SingSounds;
}

/** The UI sounds the playing Song plays (#262). */
export type SingSounds = Pick<
  UiSounds,
  "countdown" | "go" | "linePerfect" | "goldenHit"
>;

export interface StageSong {
  view(): StageSongView;
  subscribe(listener: () => void): () => void;
  /** The sing scene's media element (the video, or an `<audio>`), or `null`. */
  attach(element: PlaybackElement | null): void;
  /**
   * The backdrop's following video for separate audio and video files
   * (#212), or `null`. Such a Song plays once both elements are there.
   */
  attachVideo(video: FollowingVideoElement | null): void;
  /** Plays again after the browser refused to (call from a user gesture). */
  retryPlay(): void;
  /** The last Song that played out or was ended. */
  lastRound(): StageRound | null;
  /** Each change to a Player's running Score, Line results or lost state. */
  onScoring(listener: (change: LiveScoringChange) => void): () => void;
  dispose(): void;
}

interface Session {
  requestId: RequestId;
  songId: SongId;
  party: NonNullable<ReturnType<LiveStore["getSnapshot"]>["stage"]>["party"];
  load: Promise<SongDetail | null>;
  detail: SongDetail | null;
  setup: SingSetup | null;
  scoring: LiveScoring | null;
  /** What the sing screen draws; its pops and particles start over on Restart. */
  sing: SingState | null;
  /** The animation frame ticking the scoring, while the Song plays. */
  frame: number | null;
  buffers: readonly PitchBuffer[];
  clock: SongClock | null;
  playback: ReturnType<StageSongOptions["createPlayback"]> | null;
  controls: SongControls | null;
  /** The Party paused the Song before it could play. */
  pendingPause: boolean;
  startedAtMs: number;
  /** Stopped: nothing plays or reports any more, except a Skip's round. */
  stopped: boolean;
  ended: SongEnding | null;
  skipReported: boolean;
}

const IDLE: StageSongView = { kind: "idle" };

export function createStageSong(options: StageSongOptions): StageSong {
  const { store, pitch } = options;
  const now = options.now ?? (() => Date.now());
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const stageNow = options.stageNow ?? (() => performance.now());
  const sounds = options.sounds ?? silentSounds();
  const requestFrame =
    options.requestFrame ??
    ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ??
    ((handle) => {
      window.cancelAnimationFrame(handle);
    });
  const listeners = new Set<() => void>();
  const scoringListeners = new Set<(change: LiveScoringChange) => void>();
  let view: StageSongView = IDLE;
  let session: Session | null = null;
  let element: PlaybackElement | null = null;
  let video: FollowingVideoElement | null = null;
  let round: StageRound | null = null;

  function show(next: StageSongView) {
    view = next;
    for (const listener of [...listeners]) listener();
  }

  function update(patch: Partial<Extract<StageSongView, { kind: "singing" }>>) {
    if (view.kind === "singing") show({ ...view, ...patch });
  }

  /** Ticks the scoring once per animation frame until the Song stops or ends. */
  function scoreFrames(s: Session) {
    const scoring = s.scoring;
    if (!scoring) return;
    const onFrame = () => {
      s.frame = null;
      if (s.stopped || s.ended !== null) return;
      scoring.tick();
      s.frame = requestFrame(onFrame);
    };
    s.frame = requestFrame(onFrame);
  }

  function stopFrames(s: Session) {
    if (s.frame !== null) cancelFrame(s.frame);
    s.frame = null;
  }

  /** Stops the Song: no sound, no readings, no signal. */
  function stop(s: Session, next: StageSongView = IDLE) {
    if (!s.stopped) {
      s.stopped = true;
      stopFrames(s);
      s.controls?.dispose();
      s.playback?.dispose();
      if (s.ended === null) pitch.stop();
    }
    if (session === s) show(next);
  }

  function begin(s: Session) {
    if (s.playback || s.stopped || !s.setup || !s.clock || !element) return;
    if (view.kind !== "singing") return;
    const { plan, detail } = view;
    // Separate audio and video files: the video follows, so wait for it too.
    if (plan.follow && !video) return;
    const playback = options.createPlayback({
      element,
      video: plan.follow ? video : null,
      plan,
      clock: s.clock,
      onEnded: (how) => {
        finish(s, how);
      },
      onReport: ({ positionSeconds, rate }) => {
        // The server passes it to every Remote, which extrapolates from it.
        options.store.send({
          type: "reportSongPosition",
          requestId: s.requestId,
          positionSeconds,
          rate,
          lengthSeconds: plan.endSeconds ?? detail.lengthSeconds,
        });
      },
      onVideoShown: (videoShown) => {
        if (session === s) update({ videoShown });
      },
    });
    s.playback = playback;
    const scoring = s.scoring;
    s.controls = createSongControls({
      playback,
      buffers: () => s.buffers,
      scorers: () => (scoring ? [scoring, effectsOf(s)] : []),
      onChange: (controls) => {
        if (session !== s) return;
        const before = view.kind === "singing" ? view.controls : null;
        if (controls.phase === "countdown") sounds.countdown();
        else if (controls.phase === "playing" && before?.phase !== "playing") {
          sounds.go();
        }
        update({ controls });
      },
      onPlayFailed: () => {
        if (session === s) update({ playFailed: true });
      },
      ...(options.schedule ? { schedule: options.schedule } : {}),
      countdownFrom:
        options.countdownFrom ??
        (() => stageOptions().current().resumeCountdownSeconds),
    });
    play(s);
  }

  /** A Restart drops the Line rating pops and the particles still flying. */
  function effectsOf(s: Session): { reset(): void } {
    return {
      reset() {
        s.sing?.ratings?.clear();
        s.sing?.effects?.clear();
      },
    };
  }

  function play(s: Session) {
    const playback = s.playback;
    if (!playback) return;
    s.startedAtMs = now();
    options
      .resumeAudio()
      .then(() => playback.start())
      .then(() => {
        if (s.stopped) return;
        update({ playFailed: false });
        if (s.pendingPause) {
          s.pendingPause = false;
          s.controls?.pause();
        } else {
          sounds.go();
        }
      })
      .catch(() => {
        if (session === s && !s.stopped) update({ playFailed: true });
      });
  }

  /** The Song played out or was ended: its round is reported once. */
  function finish(s: Session, how: SongEnding) {
    if (s.ended !== null || s.stopped) return;
    s.ended = how;
    s.controls?.dispose();
    stopFrames(s);
    // Score what is due before the readings stop.
    const scoring = s.scoring?.outcome() ?? null;
    pitch.stop();
    round =
      s.detail && s.setup && scoring
        ? {
            requestId: s.requestId,
            detail: s.detail,
            setup: s.setup,
            buffers: s.buffers,
            scoring,
            startedAtMs: s.startedAtMs,
            ended: how,
            partyId: s.party?.partyId ?? "",
          }
        : null;
    if (session === s) update({ ended: how });
    void report(s, how, scoring);
  }

  /**
   * Sends the round's outcome. Ended before it loaded: once it has, with
   * nothing sung. Sent again while the answer is lost; a refusal (the Song
   * no longer plays, say) ends it.
   */
  async function report(
    s: Session,
    how: SongEnding,
    scoring: LiveScoringOutcome | null,
  ) {
    const detail = await s.load;
    const party = s.party;
    if (!detail || !party?.lineUp) return;
    const setup =
      s.setup ?? singSetup({ detail, party, profiles: options.profiles() });
    const outcome = roundOutcome({
      requestId: s.requestId,
      songId: detail.id,
      party,
      memberIds: setup.players.map((player) => player.memberId),
      scoring: scoring ?? silentOutcome(detail, setup),
      startedAtMs: s.startedAtMs,
      ended: how,
    });
    if (!outcome) return;
    for (let attempt = 1; ; attempt++) {
      try {
        await options.postRound(outcome);
        return;
      } catch (error) {
        if (attempt >= REPORT_ATTEMPTS || !worthRetrying(error)) return;
        await wait(REPORT_RETRY_MS * 2 ** (attempt - 1));
      }
    }
  }

  /** The outcome of a Song that never played: every Beat no voice. */
  function silentOutcome(
    detail: SongDetail,
    setup: SingSetup,
  ): LiveScoringOutcome {
    const clock = createSongClock({
      media: playbackPlan(detail).clock,
      now: stageNow,
    });
    return createLiveScoring({
      song: detail.song,
      noteFingerprint: detail.noteFingerprint,
      players: setup.players.map((player) => ({
        voice: player.voice,
        difficulty: player.difficulty,
        micKind: player.micKind,
        micDelayMs: player.micDelayMs,
        micThresholdDbfs: player.micThresholdDbfs,
      })),
      clock,
      buffers: () => [],
      now: stageNow,
    }).outcome();
  }

  function start(message: SongControlMessage) {
    if (session) stop(session);
    const party = store.getSnapshot().stage?.party ?? null;
    const s: Session = {
      requestId: message.requestId,
      songId: message.songId,
      party,
      load: options.loadSong(message.songId).then(
        (detail) => detail,
        () => null,
      ),
      detail: null,
      setup: null,
      scoring: null,
      sing: null,
      frame: null,
      buffers: [],
      clock: null,
      playback: null,
      controls: null,
      pendingPause: party?.playing?.paused ?? false,
      startedAtMs: now(),
      stopped: false,
      ended: null,
      skipReported: false,
    };
    session = s;
    show({ kind: "loading", requestId: s.requestId });
    void s.load.then((detail) => {
      s.detail = detail;
      if (s.stopped || s.ended !== null || session !== s) return;
      if (!detail || !party?.lineUp) {
        show({ kind: "failed", requestId: s.requestId });
        return;
      }
      // The Mic thresholds are fixed at the OpenStar volume of Start.
      const volume = store.getSnapshot().volume;
      const setup = singSetup({
        detail,
        party,
        profiles: options.profiles(),
        ...(volume === null ? {} : { volume }),
        ...(options.micIdFor ? { micIdFor: options.micIdFor } : {}),
      });
      const plan = playbackPlan(detail);
      const clock = createSongClock({ media: plan.clock, now: stageNow });
      // Each Player's scoring inputs, taken once for the whole Song.
      const scoring = createLiveScoring({
        song: detail.song,
        noteFingerprint: detail.noteFingerprint,
        players: setup.players.map((player) => ({
          voice: player.voice,
          difficulty: player.difficulty,
          micKind: player.micKind,
          micDelayMs: player.micDelayMs,
          micThresholdDbfs: player.micThresholdDbfs,
        })),
        clock,
        buffers: () => s.buffers,
        now: stageNow,
      });
      s.setup = setup;
      s.clock = clock;
      s.scoring = scoring;
      s.buffers = pitch.start({
        players: setup.players.length,
        mics: setup.mics,
        capacity: setup.capacity,
        place: scoring.placement,
        heard: (player) => {
          scoring.micEvent(player, "reading");
        },
        // A closed connection (`micClosed`), and its return (#213).
        signal: (player, kind) => {
          scoring.micEvent(player, kind);
        },
      });
      const state = setup.state(s.buffers);
      s.sing = state;
      // The last running total each seat's Phone was told (#167).
      const told: (number | null)[] = setup.players.map(() => null);
      // Each seat's golden points so far: more of them is a golden Note hit.
      const golden: number[] = setup.players.map(() => 0);
      const goldenHits = createGoldenHits({
        play: () => {
          sounds.goldenHit();
        },
        now: stageNow,
      });
      scoring.onChange((change) => {
        if (session !== s) return;
        // The seat's Phone shows its Score at each Line end, and 0 again
        // after a Restart (the only way a total drops).
        const total = change.score.total;
        const last = told[change.player] ?? null;
        if (change.lineEnds.length > 0 || (last !== null && total < last)) {
          told[change.player] = total;
          store.send({
            type: "reportLineScore",
            requestId: s.requestId,
            seat: change.player,
            total,
          });
        }
        // The header shows it at its next render; `onScoring` writes it now.
        const lane = state.lanes[change.player];
        const player = lane?.player;
        if (player) player.score = change.score.total;
        // The lost lane is drawn from `trace.lostAt`, read every frame (#213).
        if (lane?.trace) lane.trace.lostAt = change.lostAt;
        // Each ended Line pops its rating; Perfect! throws confetti (#216).
        for (const result of change.lineEnds) {
          lineEnded(state, change.player, result);
          if (result.rating >= SCORING.lineRatingScale) sounds.linePerfect();
        }
        const goldenNow = change.score.golden;
        if (goldenNow > (golden[change.player] ?? 0)) {
          goldenHits.hit(change.player);
        }
        golden[change.player] = goldenNow;
        if (change.back) {
          const seat = setup.players[change.player];
          if (seat) {
            store.showStageToast({
              code: "backOnMic",
              params: { memberId: seat.memberId, name: seat.look?.name ?? "" },
            });
          }
        }
        for (const listener of [...scoringListeners]) listener(change);
      });
      show({
        kind: "singing",
        requestId: s.requestId,
        detail,
        plan,
        state,
        clock,
        controls: { phase: "playing" },
        playFailed: false,
        ended: null,
        videoShown: plan.element === "video",
      });
      begin(s);
      scoreFrames(s);
    });
  }

  function skip(s: Session) {
    stop(s);
    if (s.skipReported) return;
    s.skipReported = true;
    const partyId = s.party?.partyId;
    void s.load.then((detail) => {
      if (!detail || !partyId) return;
      options
        .postRound({
          songId: detail.id,
          requestId: s.requestId,
          noteFingerprint: detail.noteFingerprint,
          partyId,
          mode: "normal",
          startedAtMs: s.startedAtMs,
          ended: "skipped",
          scores: [],
        })
        .catch(() => {
          // Nothing to show: a skipped round has no results.
        });
    });
  }

  function onControl(message: SongControlMessage) {
    if (message.control === "start") {
      start(message);
      return;
    }
    const s = session;
    if (!s || s.requestId !== message.requestId) return;
    switch (message.control) {
      case "skip":
        skip(s);
        return;
      case "end":
        if (s.stopped || s.ended !== null) return;
        if (s.playback) s.playback.end();
        else finish(s, "ended");
        return;
      case "pause":
      case "resume":
      case "restart":
        if (s.stopped || s.ended !== null) return;
        if (s.controls && s.playback) {
          if (message.control === "restart") {
            s.startedAtMs = now();
            // From a pause or the countdown the controls change to playing,
            // and that change plays `go`: once only.
            if (view.kind === "singing" && view.controls.phase === "playing") {
              sounds.go();
            }
          }
          s.controls.apply(message.control);
        } else {
          s.pendingPause = message.control === "pause";
        }
        return;
    }
  }

  /** A dropped Stage, or a Party that no longer plays this Song, stops it. */
  function onLive() {
    const s = session;
    if (!s || s.stopped || s.ended !== null) return;
    const live = store.getSnapshot();
    const stage = live.stage;
    const stillPlaying =
      live.connection === "open" &&
      stage?.isStage === true &&
      !stage.stageMoved &&
      stage.party?.playing?.requestId === s.requestId;
    if (!stillPlaying) stop(s);
  }

  const unsubscribeControls = store.onSongControl(onControl);
  const unsubscribeLive = store.subscribe(onLive);

  return {
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(next) {
      element = next;
      if (session && next) begin(session);
    },
    attachVideo(next) {
      video = next;
      if (session && next) begin(session);
    },
    retryPlay() {
      const s = session;
      if (s && !s.stopped && s.ended === null) play(s);
    },
    lastRound: () => round,
    onScoring(listener) {
      scoringListeners.add(listener);
      return () => {
        scoringListeners.delete(listener);
      };
    },
    dispose() {
      unsubscribeControls();
      unsubscribeLive();
      if (session) stop(session);
      session = null;
    },
  };
}
