import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ClientMessage } from "../generated/ClientMessage";
import type { LocalMicLevel } from "../generated/LocalMicLevel";
import type { PitchRouter } from "../pitch/pitchRouter";
import type { LiveClient, LiveClientOptions } from "./liveClient";
import {
  connectionChanged,
  initialLiveState,
  receive,
  type LiveState,
} from "./liveState";
import { dismissToast } from "./toasts";

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
   * Calls `listener` with every Mic bridge level relay (Stage only, ten a
   * second per metered channel); they never reach the reducer.
   */
  onLocalMicLevels: (
    listener: (levels: readonly LocalMicLevel[]) => void,
  ) => () => void;
  /** Drops a toast the screen has finished showing (`toasts.ts`). */
  dismissToast: (id: number) => void;
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
  pitch?: Pick<PitchRouter, "receive">,
): LiveStore {
  let state = initialLiveState;
  const listeners = new Set<() => void>();
  const topicListeners = new Map<ChangeTopic, Set<() => void>>();
  const levelListeners = new Set<(levels: readonly LocalMicLevel[]) => void>();

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
      // Mic bridge levels go to the meters, not the reducer.
      if (message.type === "localMicLevels") {
        for (const listener of levelListeners) listener(message.levels);
        return;
      }
      if (message.type === "changed") {
        for (const topic of message.topics) {
          for (const listener of topicListeners.get(topic) ?? []) listener();
        }
      }
      update(receive(state, message));
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
    onLocalMicLevels(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    dismissToast(id) {
      update(dismissToast(state, id));
    },
    close: () => {
      client.close();
    },
  };
}
