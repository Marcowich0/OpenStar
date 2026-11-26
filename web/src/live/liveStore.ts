import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ClientMessage } from "../generated/ClientMessage";
import type { Job } from "../generated/Job";
import type { LocalMicLevel } from "../generated/LocalMicLevel";
import type { ServerMessage } from "../generated/ServerMessage";
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
   * Calls `listener` with every job update (`JobChanged`): queued, running with
   * its percentage, done or failed. The screens that wait on a job (the Timing
   * editor's Pitch track) read them; the live state keeps none.
   */
  onJobChanged: (listener: (job: Job) => void) => () => void;
  /** Drops a toast the screen has finished showing (`toasts.ts`). */
  dismissToast: (id: number) => void;
  /** Shows a toast the Stage raises itself ("Mia is back on the mic"). */
  showStageToast: (event: StageToastEvent) => void;
  close: () => void;
}

/**
 * `hello`, when given, makes the message the store sends each time the socket
 * opens, before anything else: a Phone presents its Phone id on every
 * connect and reconnect, so a Phone already in the Party is back in at once.
 *
 * `pitch`, when given, takes every Pitch reading instead of the reducer: about
 * 100 a second per Mic go straight into their Player's ring buffer and never
 * cause a React render. Without it, readings are dropped.
 */
export function createLiveStore(
  connect: (
    handlers: Pick<LiveClientOptions, "onMessage" | "onConnection">,
  ) => LiveClient,
  hello?: () => ClientMessage,
  pitch?: Pick<PitchRouter, "receive" | "signal">,
): LiveStore {
  let state = initialLiveState;
  const listeners = new Set<() => void>();
  const topicListeners = new Map<ChangeTopic, Set<() => void>>();
  const songControlListeners = new Set<(control: SongControlMessage) => void>();
  const levelListeners = new Set<(levels: readonly LocalMicLevel[]) => void>();
  const jobListeners = new Set<(job: Job) => void>();

  function update(next: LiveState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  const client = connect({
    onMessage(message) {
      // Every server message goes to the reducer, except Pitch readings:
      // those go to their Player's ring buffer, so they never cause a render.
      if (message.type === "pitchReading") {
        pitch?.receive(message.mic, message.reading);
        return;
      }
      // A closed Mic is a lost-Mic signal for the playing Song (#213).
      if (message.type === "micClosed") {
        pitch?.signal(message.mic, "connectionClosed");
        return;
      }
      // Mic bridge levels go to the meters, not the reducer.
      if (message.type === "localMicLevels") {
        for (const listener of levelListeners) listener(message.levels);
        return;
      }
      if (message.type === "jobChanged") {
        for (const listener of [...jobListeners]) listener(message.job);
        return;
      }
      if (message.type === "changed") {
        for (const topic of message.topics) {
          for (const listener of topicListeners.get(topic) ?? []) listener();
        }
      }
      update(receive(state, message));
      if (message.type === "controlSong") {
        for (const listener of [...songControlListeners]) listener(message);
      }
    },
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
    onSongControl(listener) {
      songControlListeners.add(listener);
      return () => {
        songControlListeners.delete(listener);
      };
    },
    onLocalMicLevels(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    onJobChanged(listener) {
      jobListeners.add(listener);
      return () => {
        jobListeners.delete(listener);
      };
    },
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
