/**
 * The Stage's playing Song (#164): acts on every `controlSong` the server
 * sends the Stage, from the Stage itself or any Remote.
 *
 * - **Start** loads the head's Song, builds the sing screen's state, the
 *   Mic-to-Player map and the scorers once from the Line-up fixed at Start
 *   (`singSetup.ts`), starts the Pitch router, and plays from `#START` as soon
 *   as the sing scene hands over its media element (`attach`).
 * - **Pause, Resume, Restart** go to the Song controls (#158: freeze, 3-2-1,
 *   seek to `#START` with the buffers cleared and the scorers reset).
 * - **End** stops the Song; a Song that plays out or is ended raises one end
 *   of the Song, `reachedResults`, and its round stays in `lastRound()` for
 *   the results flow (#175).
 * - **Skip** stops the Song and reports the skipped round once
 *   (`POST /api/rounds`, no Scores); the server has already moved the Party on.
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
  PlaybackElement,
  SongEnding,
} from "../../../playback/mediaPlayback";
import {
  playbackPlan,
  type PlaybackPlan,
} from "../../../playback/playbackPlan";
import type { PitchBuffer } from "../../../pitch/pitchBuffer";
import { clockPlacement, type PitchRouter } from "../../../pitch/pitchRouter";
import type { SingState } from "../../sing/frame";
import {
  createSongControls,
  type SongControls,
  type SongControlsOptions,
  type SongControlsState,
} from "../../playback/songControls";
import { singSetup, type SingSetup } from "./singSetup";

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
    };

/** A Song that played out or was ended, for the results flow (#175). */
export interface StageRound {
  requestId: RequestId;
  detail: SongDetail;
  setup: SingSetup;
  /** Each Player's readings, as they were when the Song ended. */
  buffers: readonly PitchBuffer[];
  /** When the Song last started from its beginning (after the last Restart), Unix ms. */
  startedAtMs: number;
  ended: SongEnding;
  partyId: string;
}

export interface StageSongOptions {
  store: Pick<
    LiveStore,
    "getSnapshot" | "subscribe" | "send" | "onSongControl"
  >;
  loadSong: (id: SongId) => Promise<SongDetail>;
  /** The Profiles, for the lane headers' names and avatars. */
  profiles: () => readonly Profile[] | undefined;
  pitch: Pick<PitchRouter, "start" | "stop">;
  createPlayback: (args: {
    element: PlaybackElement;
    plan: PlaybackPlan;
    clock: SongClock;
    onEnded: (how: SongEnding) => void;
  }) => Pick<
    MediaPlayback,
    "start" | "pause" | "resume" | "restart" | "end" | "dispose"
  >;
  /** Resumes the Stage's AudioContext before playing. */
  resumeAudio: () => Promise<void>;
  /** Stores a round's outcome (`POST /api/rounds`). */
  postRound: (outcome: RoundOutcome) => Promise<unknown>;
  /** Wall-clock now, Unix ms (`Date.now`). */
  now?: () => number;
  /** The countdown's timer (`SongControlsOptions.schedule`). */
  schedule?: SongControlsOptions["schedule"];
}

export interface StageSong {
  view(): StageSongView;
  subscribe(listener: () => void): () => void;
  /** The sing scene's media element (the video, or an `<audio>`), or `null`. */
  attach(element: PlaybackElement | null): void;
  /** Plays again after the browser refused to (call from a user gesture). */
  retryPlay(): void;
  /** The last Song that played out or was ended. */
  lastRound(): StageRound | null;
  dispose(): void;
}

interface Session {
  requestId: RequestId;
  songId: SongId;
  party: NonNullable<ReturnType<LiveStore["getSnapshot"]>["stage"]>["party"];
  load: Promise<SongDetail | null>;
  detail: SongDetail | null;
  setup: SingSetup | null;
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
  const listeners = new Set<() => void>();
  let view: StageSongView = IDLE;
  let session: Session | null = null;
  let element: PlaybackElement | null = null;
  let round: StageRound | null = null;

  function show(next: StageSongView) {
    view = next;
    for (const listener of [...listeners]) listener();
  }

  function update(patch: Partial<Extract<StageSongView, { kind: "singing" }>>) {
    if (view.kind === "singing") show({ ...view, ...patch });
  }

  /** Stops the Song: no sound, no readings, no signal. */
  function stop(s: Session, next: StageSongView = IDLE) {
    if (!s.stopped) {
      s.stopped = true;
      s.controls?.dispose();
      s.playback?.dispose();
      if (s.ended === null) pitch.stop();
    }
    if (session === s) show(next);
  }

  function begin(s: Session) {
    if (s.playback || s.stopped || !s.setup || !s.clock || !element) return;
    if (view.kind !== "singing") return;
    const playback = options.createPlayback({
      element,
      plan: view.plan,
      clock: s.clock,
      onEnded: (how) => {
        finish(s, how);
      },
    });
    s.playback = playback;
    const setup = s.setup;
    s.controls = createSongControls({
      playback,
      buffers: () => s.buffers,
      scorers: () => setup.scorers,
      onChange: (controls) => {
        if (session === s) update({ controls });
      },
      onPlayFailed: () => {
        if (session === s) update({ playFailed: true });
      },
      ...(options.schedule ? { schedule: options.schedule } : {}),
    });
    play(s);
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
        }
      })
      .catch(() => {
        if (session === s && !s.stopped) update({ playFailed: true });
      });
  }

  /** The Song played out or was ended: one end of the Song, then the results. */
  function finish(s: Session, how: SongEnding) {
    if (s.ended !== null || s.stopped) return;
    s.ended = how;
    s.controls?.dispose();
    pitch.stop();
    // Ended before it loaded: the end of the Song still goes out, with no round.
    round =
      s.detail && s.setup
        ? {
            requestId: s.requestId,
            detail: s.detail,
            setup: s.setup,
            buffers: s.buffers,
            startedAtMs: s.startedAtMs,
            ended: how,
            partyId: s.party?.partyId ?? "",
          }
        : null;
    store.send({ type: "reachedResults", requestId: s.requestId, ended: how });
    if (session === s) update({ ended: how });
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
      });
      const plan = playbackPlan(detail);
      const clock = createSongClock({ media: plan.clock });
      const players = setup.players;
      s.setup = setup;
      s.clock = clock;
      s.buffers = pitch.start({
        players: players.length,
        mics: setup.mics,
        capacity: setup.capacity,
        place: clockPlacement(
          clock,
          (player) => players[player]?.micDelayMs ?? 0,
        ),
      });
      show({
        kind: "singing",
        requestId: s.requestId,
        detail,
        plan,
        state: setup.state(s.buffers),
        clock,
        controls: { phase: "playing" },
        playFailed: false,
        ended: null,
      });
      begin(s);
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
          if (message.control === "restart") s.startedAtMs = now();
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
    retryPlay() {
      const s = session;
      if (s && !s.stopped && s.ended === null) play(s);
    },
    lastRound: () => round,
    dispose() {
      unsubscribeControls();
      unsubscribeLive();
      if (session) stop(session);
      session = null;
    },
  };
}
