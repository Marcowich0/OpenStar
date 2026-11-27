import type { AvSyncStep } from "../generated/AvSyncStep";
import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ClientMessage } from "../generated/ClientMessage";
import type { Job } from "../generated/Job";
import type { LocalMicLevel } from "../generated/LocalMicLevel";
import type { MicId } from "../generated/MicId";
import type { PitchReading } from "../generated/PitchReading";
import type { ServerMessage } from "../generated/ServerMessage";
import type { StageMicReport } from "../generated/StageMicReport";
import type { ClockPongFields } from "../pitch/clock/senderSession";
import type { PitchRouter } from "../pitch/pitchRouter";
import type { LiveClient, LiveClientOptions } from "./liveClient";
import {
  connectionChanged,
  initialLiveState,
  receive,
  type LiveState,
} from "./liveState";
import { addStageToast, dismissToast, type StageToastEvent } from "./toasts";

/** What the server tells the Stage to do to the head's Song. */
export type SongControlMessage = Extract<
  ServerMessage,
  { type: "controlSong" }
>;

/**
 * One store per browser: the live state, updated by the one reducer from
 * what the WebSocket client receives. React reads it through
 * `useSyncExternalStore`.
 */
export interface LiveStore {
  getSnapshot: () => LiveState;
  subscribe: (listener: () => void) => () => void;
  send: (message: ClientMessage) => boolean;
  /** Calls `listener` whenever a change notice names `topic`. */
  onChanged: (topic: ChangeTopic, listener: () => void) => () => void;
  /**
   * Calls `listener` with every `controlSong` the server sends the Stage
   * (Start, Pause, …), after the `partyChanged` that reports it was applied.
   * The sing scene's playback acts on these (#164).
   */
  onSongControl: (
    listener: (control: SongControlMessage) => void,
  ) => () => void;
  /**
   * Calls `listener` with every Mic bridge level relay (Stage only, ten a
   * second per metered channel); they never reach the reducer.
   */
  onLocalMicLevels: (
    listener: (levels: readonly LocalMicLevel[]) => void,
  ) => () => void;
  /**
   * Calls `listener` with every relayed Pitch reading (Stage only), besides
   * the Pitch router: the seat meters show a Phone's loudness from them.
   * They never reach the reducer.
   */
  onPitchReading: (
    listener: (mic: MicId, reading: PitchReading) => void,
  ) => () => void;
  /**
   * Calls `listener` with every `clockPong` the Stage sent this browser's
   * Mic (a Phone's capture pipeline); they never reach the reducer.
   */
  onClockPong: (listener: (pong: ClockPongFields) => void) => () => void;
  /**
   * Calls `listener` with every job update (`JobChanged`): queued, running with
   * its percentage, done or failed. The screens that wait on a job (the Timing
   * editor's Pitch track) read them; the live state keeps none.
   */
  onJobChanged: (listener: (job: Job) => void) => () => void;
  /**
   * Calls `listener` with every Remote's Check A/V sync press the server
   * relays to the Stage (#163); the Stage saves the new value itself. They
   * never reach the reducer.
   */
  onAvSyncStep: (listener: (step: AvSyncStep) => void) => () => void;
  /**
   * Calls `listener` with every Phone's ask for its mic diagnostics the
   * server relays to the Stage (`micReportRequest`); the Stage answers with
   * `micReport`. They never reach the reducer.
   */
  onMicReportRequest: (listener: (mic: MicId) => void) => () => void;
  /**
   * Calls `listener` with every `micReport` the Stage sent this Phone's Mic
   * (its diagnostics view); they never reach the reducer.
   */
  onMicReport: (listener: (report: StageMicReport) => void) => () => void;
  /** Drops a toast the screen has finished showing (`toasts.ts`). */
  dismissToast: (id: number) => void;
  /** Shows a toast the Stage raises itself ("Mia is back on the mic"). */
  showStageToast: (event: StageToastEvent) => void;
  close: () => void;
}

/** Listeners of one kind of value; `emit` calls each one once. */
function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: (listener: (value: T) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (value: T) => {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

/** This page's clock, as the Stage's pong reports it. */
export interface PageClock {
  now: () => number;
  epoch: () => number;
}

const performancePageClock: PageClock = {
  now: () => performance.now(),
  epoch: () => performance.timeOrigin,
};

/**
 * `hello`, when given, makes the message the store sends each time the socket
 * opens, before anything else: a Phone presents its Phone id on every
 * connect and reconnect, so a Phone already in the Party is back in at once.
 *
 * `pitch`, when given, takes every Pitch reading instead of the reducer: about
 * 100 a second per Mic go straight into their Player's ring buffer and never
 * cause a React render. Without it, readings are dropped.
 *
 * `pageClock` is what the Stage answers a relayed `clockPing` with: this
 * page's `performance.now()` and its epoch, `performance.timeOrigin`.
 */
export function createLiveStore(
  connect: (
    handlers: Pick<LiveClientOptions, "onMessage" | "onConnection">,
  ) => LiveClient,
  hello?: () => ClientMessage,
  pitch?: Pick<PitchRouter, "receive" | "signal">,
  pageClock: PageClock = performancePageClock,
): LiveStore {
  let state = initialLiveState;
  const listeners = new Set<() => void>();
  const topicListeners = new Map<ChangeTopic, Set<() => void>>();
  const songControls = emitter<SongControlMessage>();
  const levels = emitter<readonly LocalMicLevel[]>();
  const pongs = emitter<ClockPongFields>();
  const readings = emitter<{ mic: MicId; reading: PitchReading }>();
  const jobs = emitter<Job>();
  const avSyncSteps = emitter<AvSyncStep>();
  const micReportRequests = emitter<MicId>();
  const micReports = emitter<StageMicReport>();

  function update(next: LiveState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  /**
   * Where each server message goes. The live state's messages go to the
   * reducer; the rest never cause a render: Pitch readings go to their
   * Player's ring buffer, the rest to the listeners that asked for them.
   * Exhaustive, like the reducer's own `switch`: a new message type is
   * refused by the linter until it is routed here.
   */
  function route(message: ServerMessage) {
    switch (message.type) {
      case "pitchReading":
        pitch?.receive(message.mic, message.reading);
        readings.emit({ mic: message.mic, reading: message.reading });
        return;
      case "clockPing":
        // Clock sync (v1 spec #50): the Stage answers a Mic's ping at once,
        // waiting on nothing.
        client.send({
          type: "clockPong",
          mic: message.mic,
          t0: message.t0,
          ts: pageClock.now(),
          epoch: pageClock.epoch(),
        });
        return;
      case "clockPong":
        // A Phone's Mic takes the pong.
        pongs.emit({ t0: message.t0, ts: message.ts, epoch: message.epoch });
        return;
      case "micReportRequest":
        // Stage only: a Phone's diagnostics ask what the Stage receives.
        micReportRequests.emit(message.mic);
        return;
      case "micReport":
        // The Stage's answer, for this Phone's diagnostics.
        micReports.emit(message.report);
        return;
      case "micClosed":
        // A closed Mic is a lost-Mic signal for the playing Song (#213).
        pitch?.signal(message.mic, "connectionClosed");
        return;
      case "micPage":
        // A Phone's page hidden or visible again is one too (#166).
        pitch?.signal(
          message.mic,
          message.visible ? "pageVisible" : "pageHidden",
        );
        return;
      case "localMicLevels":
        // Mic bridge levels go to the meters.
        levels.emit(message.levels);
        return;
      case "stepAvSync":
        avSyncSteps.emit(message.step);
        return;
      case "jobChanged":
        jobs.emit(message.job);
        return;
      case "changed":
        // Change notices invalidate HTTP data; they change no live state.
        for (const topic of message.topics) {
          for (const listener of topicListeners.get(topic) ?? []) listener();
        }
        return;
      case "controlSong":
        // Stage only: the Stage's playback acts on it (#164); the Party's
        // `playing` state came with the `partyChanged` before it.
        songControls.emit(message);
        return;
      case "bridgeUpdate":
      case "bridgeWaiting":
      case "bridgeApproved":
      case "bridgeConnected":
      case "bridgeChannels":
      case "bridgeMicsScreen":
      case "bridgeDetecting":
      case "bridgeSwitchProfile":
        // Only a Mic bridge's own socket gets these.
        return;
      case "liveState":
      case "partyChanged":
      case "stageMoved":
      case "rejected":
      case "pong":
      case "phoneStatus":
      case "leftParty":
      case "joinCodeValid":
      case "volume":
      case "songProgress":
      case "lineScore":
      case "avSync":
      case "avSyncCheck":
      case "calibration":
        // A Song progress report is pinned to when it arrived (#159).
        update(receive(state, message, performance.now()));
    }
  }

  const client = connect({
    onMessage: route,
    onConnection(connection) {
      if (connection === "open" && hello) client.send(hello());
      update(connectionChanged(state, connection));
    },
  });

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: (message) => client.send(message),
    onChanged(topic, listener) {
      const set = topicListeners.get(topic) ?? new Set();
      set.add(listener);
      topicListeners.set(topic, set);
      return () => {
        set.delete(listener);
      };
    },
    onSongControl: songControls.subscribe,
    onLocalMicLevels: levels.subscribe,
    onPitchReading: (listener) =>
      readings.subscribe(({ mic, reading }) => {
        listener(mic, reading);
      }),
    onClockPong: pongs.subscribe,
    onJobChanged: jobs.subscribe,
    onAvSyncStep: avSyncSteps.subscribe,
    onMicReportRequest: micReportRequests.subscribe,
    onMicReport: micReports.subscribe,
    dismissToast(id) {
      update(dismissToast(state, id));
    },
    showStageToast(event) {
      update({ ...state, ...addStageToast(state, event) });
    },
    close: () => {
      client.close();
    },
  };
}
