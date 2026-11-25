import type { ServerMessage } from "../generated/ServerMessage";
import type { StageId } from "../generated/StageId";
import type { UserMessage } from "../generated/UserMessage";

/** Where the browser's one WebSocket stands. */
export type LiveConnection = "connecting" | "open" | "reconnecting";

/**
 * The browser's copy of the live state the server owns. Until #48 the Stage
 * state is a placeholder text; #48 replaces it with the Party.
 */
export interface LiveState {
  connection: LiveConnection;
  /** `null` until the server has told this browser the state. */
  stage: { stageId: StageId; placeholder: string } | null;
  lastRejection: UserMessage | null;
  lastPong: number | null;
}

export const initialLiveState: LiveState = {
  connection: "connecting",
  stage: null,
  lastRejection: null,
  lastPong: null,
};

/** Applies a server message. The `switch` is exhaustive over the generated union. */
export function receive(state: LiveState, message: ServerMessage): LiveState {
  switch (message.type) {
    case "liveState":
      return {
        ...state,
        stage: { stageId: message.stageId, placeholder: message.placeholder },
      };
    case "placeholderChanged":
      return state.stage?.stageId === message.stageId
        ? {
            ...state,
            stage: { ...state.stage, placeholder: message.placeholder },
          }
        : state;
    case "rejected":
      return { ...state, lastRejection: message.reason };
    case "pong":
      return { ...state, lastPong: message.nonce };
    case "changed":
      // Change notices invalidate HTTP data; they change no live state.
      return state;
    default:
      return unreachable(message);
  }
}

/** The WebSocket opened, closed or is being opened again. */
export function connectionChanged(
  state: LiveState,
  connection: LiveConnection,
): LiveState {
  return state.connection === connection ? state : { ...state, connection };
}

function unreachable(value: never): never {
  throw new Error(`unhandled server message: ${JSON.stringify(value)}`);
}
