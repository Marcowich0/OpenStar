import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ClientMessage } from "../generated/ClientMessage";
import type { LiveClient, LiveClientOptions } from "./liveClient";
import {
  connectionChanged,
  initialLiveState,
  receive,
  type LiveState,
} from "./liveState";

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
  close: () => void;
}

export function createLiveStore(
  connect: (
    handlers: Pick<LiveClientOptions, "onMessage" | "onConnection">,
  ) => LiveClient,
): LiveStore {
  let state = initialLiveState;
  const listeners = new Set<() => void>();
  const topicListeners = new Map<ChangeTopic, Set<() => void>>();

  function update(next: LiveState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  const client = connect({
    onMessage(message) {
      // Every server message goes to the reducer, except Pitch readings:
      // #127 routes those to their Player's ring buffer here, before the
      // reducer, so they never cause a React render.
      if (message.type === "changed") {
        for (const topic of message.topics) {
          for (const listener of topicListeners.get(topic) ?? []) listener();
        }
      }
      update(receive(state, message));
    },
    onConnection(connection) {
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
    close: () => {
      client.close();
    },
  };
}
